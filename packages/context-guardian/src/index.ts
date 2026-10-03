/**
 * context-guardian：上下文守护者。
 *
 * 针对每个会话的上下文做价值感知的自动压缩与剪枝，保留有用信息、清理污染，
 * 避免上下文过长或被污染。协作者模式：只调用平台的 tokenMeter / compaction
 * 服务与 Session 表面替换协议，不覆盖任何内置服务，插件异常绝不影响 DSH 本体。
 *
 * 三层时机（对齐官方 compaction-basic）：
 *  - `agent/pre-step`：模型请求前做零成本剪枝/污染清理（提前干预，不阻塞管线）；
 *  - `agent/request-error`：context-overflow 失败时强制剪枝+压缩并请求重试；
 *  - `session/event` 去抖巡检：压力高的会话做完整 清理→剪枝→压缩 分级处置。
 *
 * 异常隔离：所有事件监听、异步巡检、平台调用都在各自 try/catch 内，失败只
 * 记日志；所有监听器经 ctx.effect 注册，插件卸载零残留。
 * @module @dsh-my-plugin/context-guardian
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createObservability } from '@dsh-my-plugin/observability'
import { Config, resolveConfig, pressureLevel } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { inspectAgent, interveneBeforeStep, recoverFromOverflow } from './orchestrator.ts'
import type { Platform } from './orchestrator.ts'
import { projectSurface } from './project.ts'

export const name = 'context-guardian'

/** apply 阶段需要注入的服务：agents 遍历活跃 agent；tokenMeter 测压；compaction 定点压缩；tools 注册统计工具。 */
export const inject = ['agents', 'tokenMeter', 'compaction', 'tools']

export { Config }
export type { Config as ConfigType } from './config.ts'
export { resolveConfig, pressureLevel } from './config.ts'
export { scanSurface, pickBestRange, selectCompactRangeByRetention, matchesProtectedKeyword, isNoisyText } from './scan.ts'
export { trimText, extractText, PRUNE_MARKER, POLLUTION_MARKER } from './execute.ts'
export { inspectAgent, interveneBeforeStep, recoverFromOverflow } from './orchestrator.ts'

/** 每个会话的去抖状态：上一次巡检时间与是否正在巡检。 */
interface SessionGuardState {
  lastInspectAt: number
  inFlight: boolean
}

/**
 * 插件应用函数：挂载三个时机的监听（pre-step / request-error / session/event）。
 * apply 内所有注册逻辑包 try/catch：注册失败仅记日志，插件加载失败不影响 DSH。
 * @param ctx - 注册上下文。
 * @param config - 部署配置（schema 已补默认值）。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const logger = ctx.logger('context-guardian')
  const guards = new Map<string, SessionGuardState>()

  if (!resolved.enabled) {
    logger.info('context-guardian disabled by config')
    return
  }

  try {
    // 可观测性记录器：持久化到 $DSH_HOME/observability/events.json。
    const obs = createObservability({ plugin: '@dsh-my-plugin/context-guardian' })

    // 平台能力闭包：测量 / 投影 / 影子价格 / 配对平衡 / 定点压缩 / 观测。
    const platform: Platform = {
      measure(session) {
        const measurement = ctx.tokenMeter.measure(session)
        return { totalTokens: measurement.totalTokens, surfaceTokens: measurement.surfaceTokens }
      },
      project(session) {
        const measurement = ctx.tokenMeter.measure(session)
        return projectSurface(session, measurement)
      },
      estimateMessage(message) {
        return ctx.tokenMeter.estimateMessage(message as never)
      },
      balancedBefore(session, seq) {
        return toolPairingBalancedBefore(session, seq as never)
      },
      compactRegion(start, end, agentCtx, signal) {
        return ctx.compaction.compactRegion(start as never, end as never, agentCtx, signal)
      },
      observe(input) {
        return obs.record(input)
      },
      log: logger,
    }

    // 观测工具：让模型能随时查询插件效果（剪枝/压缩/污染/溢出的节省量）。
    try {
      ctx.tools.register(defineTool({
        name: 'guardian_stats',
        description:
          'Query how much context the context-guardian plugin has freed up: total actions, '
          + 'tokens and characters saved by pruning, compaction, pollution cleanup, and overflow '
          + 'recovery. Use to verify the plugin is working and to decide whether thresholds should '
          + 'be tuned.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute() {
          // 统计查询只读且精简，失败返回错误文本而非抛异常。
          try {
            const stats = obs.stats().find((s) => s.plugin === '@dsh-my-plugin/context-guardian')
            if (stats === undefined) {
              return { text: 'context-guardian: no effects recorded yet.' }
            }
            const t = stats.total
            const kinds = Object.entries(stats.byKind)
              .map(([kind, k]) => `${kind}: ${k.count} (ok ${k.success}, saved ${k.tokensSaved} tokens / ${k.charsSaved} chars)`)
              .join('\n')
            return {
              text: `context-guardian effects\n`
                + `total: ${t.count} actions (${t.success} ok / ${t.failure} fail)\n`
                + `saved: ~${t.tokensSaved} tokens, ${t.charsSaved} chars\n`
                + `---\n${kinds}`,
            }
          } catch (error) {
            return { text: `guardian_stats failed: ${messageOf(error)}` }
          }
        },
      }))
    } catch (error) {
      logger.warn('guardian_stats tool registration failed: %s', messageOf(error))
    }

    // 定期日志汇总：让效果在日志中可见（供后续优化参考）。标准定时器 + ctx.effect 回收。
    const summarizeTimer = setInterval(() => obs.summarize(logger), 60_000)
    ctx.effect(() => () => clearInterval(summarizeTimer))

    // 时机 1：模型请求前，零成本提前干预（剪枝/污染清理），不阻塞管线。
    ctx.on('agent/pre-step', async (payload: { agent: Agent; signal: AbortSignal }, next) => {
      try {
        await interveneBeforeStep(payload.agent, platform, resolved, payload.signal)
      } catch (error) {
        logger.debug('pre-step intervention failed: %s', messageOf(error))
      }
      return next()
    })

    // 时机 2：context-overflow 失败恢复——强制剪枝+压缩，请求重试一次。
    ctx.on('agent/request-error', async (payload: {
      agent: Agent
      failure: { code: string }
      signal: AbortSignal
    }, next) => {
      if (payload.failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || payload.signal.aborted) return next()
      try {
        const recovered = await recoverFromOverflow(payload.agent, platform, resolved, payload.signal)
        if (recovered && !payload.signal.aborted) return { kind: 'retry' }
      } catch (error) {
        logger.warn('overflow recovery failed: %s', messageOf(error))
      }
      return next()
    })

    // 时机 3：事件后去抖巡检（完整分级处置）。
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      switch (event.type) {
        case 'user/message':
        case 'assistant/message':
        case 'tool/result':
          break
        default:
          return
      }
      scheduleInspect(ctx, resolved, platform, guards, session, logger)
    })
  } catch (error) {
    logger.error('context-guardian failed to register: %s', messageOf(error))
  }
}

/** 按会话去抖调度一次巡检（fire-and-forget，绝不阻塞事件流）。 */
function scheduleInspect(
  ctx: Context,
  resolved: ResolvedConfig,
  platform: Platform,
  guards: Map<string, SessionGuardState>,
  session: Session,
  logger: ReturnType<Context['logger']>,
): void {
  try {
    const id = session.id
    const now = Date.now()
    const state = guards.get(id)
    if (state !== undefined) {
      if (state.inFlight) return
      if (now - state.lastInspectAt < resolved.inspectIntervalMs) return
    }
    guards.set(id, { lastInspectAt: now, inFlight: true })

    // fire-and-forget：巡检结果异步落地，事件流不被阻塞。
    void (async () => {
      try {
        const agent = ctx.agents.get(id)
        if (agent === undefined) return
        const signal = new AbortController().signal
        await inspectAgent(agent, platform, resolved, signal)
      } catch (error) {
        logger.warn('inspect failed for %s: %s', id, messageOf(error))
      } finally {
        const current = guards.get(id)
        if (current !== undefined) guards.set(id, { ...current, inFlight: false })
      }
    })()
  } catch (error) {
    // 调度本身失败（如 Map 写入异常）：记录后跳过本次，不向上抛。
    logger.warn('schedule failed: %s', messageOf(error))
  }
}

/** 错误到可读字符串的容错转换。 */
function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'unknown error'
  }
}