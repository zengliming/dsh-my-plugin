/**
 * 调度器：把一次"巡检"组织为 测量 → 扫描 → 分级执行。
 *
 * 依赖注入方式：构造函数接收平台服务闭包（tokenMeter/compaction/projector 等），
 * 不直接持有 Context，便于在不挂载插件的情况下单测决策逻辑。所有异步步骤包
 * try/catch，单个步骤失败不中断后续步骤，更不会向调用方抛异常。
 * @module @dsh-my-plugin/context-guardian/orchestrator
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionAgentContext } from '@deepseek-ai/dsh-compaction'
import type { Logger } from '@deepseek-ai/cordis'
import { pressureLevel, shouldCompact, shouldPrune, shouldCleanPollution } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { scanSurface, pickBestRange } from './scan.ts'
import type { SurfaceNodeView } from './types.ts'
import { pruneNode, replacePollution } from './execute.ts'
import { projectSurface } from './project.ts'

/** 平台能力接口：调度器只依赖这些闭包，运行时由 index 注入。 */
export interface Platform {
  /** 测量会话 token 压力。 */
  measure(session: Session): { totalTokens: number; surfaceTokens: number }
  /** 投影表面节点（含 token）。 */
  project(session: Session): SurfaceNodeView[]
  /** 定点压缩一个表面区间（平台 compaction.compactRegion 的适配）。 */
  compactRegion(start: number, end: number, agent: CompactionAgentContext, signal: AbortSignal): Promise<unknown>
  /** 记录日志（带插件的 scope）。 */
  log: Logger
}

/** 一次巡检的摘要（供日志与测试）。 */
export interface InspectSummary {
  readonly totalTokens: number
  readonly protectedSeqs: readonly number[]
  readonly pruned: readonly number[]
  readonly pollution: readonly number[]
  readonly compacted: { start: number; end: number } | undefined
}

/**
 * 对单个 agent 的会话执行一次完整巡检。
 * @param agent - 目标 agent（提供 session 与路由 options）。
 * @param platform - 平台能力闭包。
 * @param config - 已解析配置。
 * @param signal - 取消信号。
 * @returns 本次巡检摘要（即使无动作也返回，供上层去抖）。
 */
export async function inspectAgent(
  agent: Agent,
  platform: Platform,
  config: ResolvedConfig,
  signal: AbortSignal,
): Promise<InspectSummary> {
  const session: Session = agent.session
  const protectedSeqs: number[] = []
  const pruned: number[] = []
  const pollution: number[] = []
  let compacted: { start: number; end: number } | undefined
  let totalTokens = 0

  // ---- L1：测量 ----
  let measurement
  try {
    measurement = platform.measure(session)
  } catch (error) {
    platform.log.warn('measure failed: %s', messageOf(error))
    return { totalTokens, protectedSeqs, pruned, pollution, compacted }
  }
  totalTokens = measurement.totalTokens
  const level = pressureLevel(measurement.totalTokens, config)
  platform.log.debug('inspect %s level=%s tokens=%d', session.id, level, measurement.totalTokens)

  if (!shouldPrune(level) && !shouldCompact(level)) return { totalTokens, protectedSeqs, pruned, pollution, compacted }

  // ---- L2：投影 + 扫描 ----
  let nodes: SurfaceNodeView[]
  try {
    nodes = platform.project(session)
  } catch (error) {
    platform.log.warn('project failed: %s', messageOf(error))
    return { totalTokens, protectedSeqs, pruned, pollution, compacted }
  }
  const scan = scanSurface(nodes, {
    toolResultCharLimit: config.toolResultCharLimit,
    protectRecentMessages: config.protectRecentMessages,
    protectKeywords: config.protectKeywords,
    pruneToolResults: config.pruneToolResults,
    pollutionCleanup: config.pollutionCleanup,
  })
  protectedSeqs.push(...scan.protectedSeqs)

  // ---- L3a：污染清理（最高优先级，成本最低） ----
  if (shouldCleanPollution(level) && config.pollutionCleanup) {
    for (const seq of scan.pollutionSeqs) {
      if (signal.aborted) break
      const node = nodes.find((n) => n.seq === seq)
      if (node === undefined) continue
      try {
        if (replacePollution(session, node)) {
          pollution.push(seq)
          platform.log.info('pollution replaced seq=%d tokens=%d', seq, node.tokens)
        }
      } catch (error) {
        platform.log.warn('pollution replace failed seq=%d: %s', seq, messageOf(error))
      }
    }
  }

  // ---- L3b：价值剪枝（模型无关，渐进式） ----
  if (shouldPrune(level) && config.pruneToolResults) {
    for (const seq of scan.prunableSeqs) {
      if (signal.aborted) break
      const node = nodes.find((n) => n.seq === seq)
      if (node === undefined) continue
      try {
        if (pruneNode(session, node, config.toolResultCharLimit)) {
          pruned.push(seq)
          platform.log.info('pruned seq=%d tokens=%d', seq, node.tokens)
        }
      } catch (error) {
        platform.log.warn('prune failed seq=%d: %s', seq, messageOf(error))
      }
    }
  }

  // ---- L3c：定点压缩（模型摘要，压力最高时执行） ----
  if (shouldCompact(level) && !signal.aborted) {
    const best = pickBestRange(scan.compressibleRanges, config.minSavingsTokens)
    if (best !== undefined) {
      try {
        const ctx: CompactionAgentContext = { session, options: { ...agent.options } }
        await platform.compactRegion(best.start, best.end, ctx, signal)
        compacted = { start: best.start, end: best.end }
        platform.log.info(
          'compact region %d..%d savings=%d tokens=%d',
          best.start, best.end, best.savingsTokens, measurement.totalTokens,
        )
      } catch (error) {
        platform.log.warn('compact region %d..%d failed: %s', best.start, best.end, messageOf(error))
      }
    }
  }

  return { totalTokens, protectedSeqs, pruned, pollution, compacted }
}

/** 错误到可读字符串的容错转换（绝不因格式化异常再次抛出）。 */
function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'unknown error'
  }
}