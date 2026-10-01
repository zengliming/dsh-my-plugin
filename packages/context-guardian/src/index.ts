/**
 * context-guardian：上下文守护者。
 *
 * 针对每个会话的上下文做价值感知的自动压缩与剪枝，保留有用信息、清理污染，
 * 避免上下文过长或被污染。协作者模式：只调用平台的 tokenMeter / compaction
 * 服务与 Session 表面替换协议，不覆盖任何内置服务，插件异常绝不影响 DSH 本体。
 *
 * 工作方式：监听 `session/event`，对每个活跃 agent 的会话做去抖巡检；
 * 巡检按压力分级执行 污染清理 → 价值剪枝 → 低价值区间压缩。
 *
 * 异常隔离：所有事件监听、异步巡检、平台调用都在各自 try/catch 内，失败只
 * 记日志；所有监听器经 ctx.effect 注册，插件卸载零残留。
 * @module @dsh-my-plugin/context-guardian
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { Config, resolveConfig, pressureLevel } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import type { SurfaceNodeView } from './types.ts'
import { inspectAgent } from './orchestrator.ts'
import type { Platform } from './orchestrator.ts'
import { projectSurface } from './project.ts'

export const name = 'context-guardian'

/** apply 阶段需要注入的服务：agents 遍历活跃 agent；tokenMeter 测压；compaction 定点压缩。 */
export const inject = ['agents', 'tokenMeter', 'compaction']

export { Config }
export type { Config as ConfigType } from './config.ts'
export { resolveConfig, pressureLevel } from './config.ts'
export { scanSurface, pickBestRange, matchesProtectedKeyword, isNoisyText } from './scan.ts'
export { trimText, extractText, PRUNE_MARKER, POLLUTION_MARKER } from './execute.ts'

/** 每个会话的去抖状态：上一次巡检时间与是否正在巡检。 */
interface SessionGuardState {
  lastInspectAt: number
  inFlight: boolean
}

/**
 * 插件应用函数：挂载 session/event 监听，按会话去抖调度巡检。
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
    // 平台能力闭包：测量 / 投影 / 定点压缩。
    const platform: Platform = {
      measure(session) {
        const measurement = ctx.tokenMeter.measure(session)
        return { totalTokens: measurement.totalTokens, surfaceTokens: measurement.surfaceTokens }
      },
      project(session) {
        const measurement = ctx.tokenMeter.measure(session)
        return projectSurface(session, measurement)
      },
      compactRegion(start, end, agentCtx, signal) {
        return ctx.compaction.compactRegion(start, end, agentCtx, signal)
      },
      log: logger,
    }

    ctx.on('session/event', (session: Session, event) => {
      // 只关心表面消息事件（消息追加/替换），边界与计量事件不触发巡检。
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
    logger.error('context-guardian failed to register: %s', error instanceof Error ? error.message : String(error))
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
        logger.warn('inspect failed for %s: %s', id, error instanceof Error ? error.message : String(error))
      } finally {
        const current = guards.get(id)
        if (current !== undefined) guards.set(id, { ...current, inFlight: false })
      }
    })()
  } catch (error) {
    // 调度本身失败（如 Map 写入异常）：记录后跳过本次，不向上抛。
    logger.warn('schedule failed: %s', error instanceof Error ? error.message : String(error))
  }
}