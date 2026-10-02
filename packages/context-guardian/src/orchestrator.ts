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
import { scanSurface, pickBestRange, selectCompactRangeByRetention } from './scan.ts'
import type { SurfaceNodeView } from './types.ts'
import { pruneNode, replacePollution } from './execute.ts'
import { projectSurface } from './project.ts'
import type { BalancedBefore } from './types.ts'

/** 平台能力接口：调度器只依赖这些闭包，运行时由 index 注入。 */
export interface Platform {
  /** 测量会话 token 压力。 */
  measure(session: Session): { totalTokens: number; surfaceTokens: number }
  /** 投影表面节点（含 token）。 */
  project(session: Session): SurfaceNodeView[]
  /** 估算一条消息的 token 数（影子价格用；官方 pruner 以 estimateMessage 计价）。 */
  estimateMessage(message: unknown): number
  /** 工具配对平衡检查：seq 之前的切点是否安全（官方 toolPairingBalancedBefore）。 */
  balancedBefore(session: Session, seq: number): boolean
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
        if (replacePollution(session, node, node.tokens)) {
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
        if (pruneNode(session, node, config.toolResultCharLimit, node.tokens)) {
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
    // 剪枝/污染已改变表面节点计数——重新投影后再选区间，保证平衡检查读到最新表面。
    let latestNodes = nodes
    try {
      latestNodes = platform.project(session)
    } catch (error) {
      platform.log.warn('re-project before compact failed: %s', messageOf(error))
    }
    // 主策略：官方风格（尾部 retainTokens 预算 + 工具配对平衡）；
    // 兜底：价值扫描的保护区间（最近消息/关键词之外的连续低价值节点）。
    const retentionRange = trySelectByRetention(session, latestNodes, config, platform)
    const fallbackRange = pickBestRange(scan.compressibleRanges, config.minSavingsTokens)
    const best = pickPreferredRange(retentionRange, fallbackRange, config.minSavingsTokens)
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

/**
 * 以官方策略（尾部 retainTokens 预算 + 工具配对平衡）选择压缩区间。
 * 失败（表面不一致、平衡检查抛错）时返回 undefined，退回保护区间策略。
 */
function trySelectByRetention(
  session: Session,
  nodes: readonly SurfaceNodeView[],
  config: ResolvedConfig,
  platform: Platform,
): { start: number; end: number; savingsTokens: number } | undefined {
  try {
    const balancedBefore: BalancedBefore = (seq) => platform.balancedBefore(session, seq)
    return selectCompactRangeByRetention(nodes, config.retainTokens, balancedBefore)
  } catch (error) {
    platform.log.debug('retention-based range selection failed: %s', messageOf(error))
    return undefined
  }
}

/**
 * 在保留式区间（主）与保护区间候选（兜底）间选择：
 * 主策略满足最低节省量则用之；否则退回兜底（也需满足最低节省量）。
 */
function pickPreferredRange(
  primary: { start: number; end: number; savingsTokens: number } | undefined,
  fallback: { start: number; end: number; savingsTokens: number } | undefined,
  minSavingsTokens: number,
): { start: number; end: number; savingsTokens: number } | undefined {
  if (primary !== undefined && primary.savingsTokens >= minSavingsTokens) return primary
  if (fallback !== undefined && fallback.savingsTokens >= minSavingsTokens) return fallback
  return undefined
}

/** 错误到可读字符串的容错转换（绝不因格式化异常再次抛出）。 */
function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'unknown error'
  }
}

/**
 * 模型请求前的提前干预（agent/pre-step 用）：只做零成本的污染清理与价值剪枝，
 * 不做模型摘要压缩——压缩会阻塞请求管线，留给溢出恢复与事件后巡检。
 * 失败仅记日志，绝不影响请求继续。
 * @param agent - 即将发起请求的 agent。
 * @param platform - 平台能力闭包。
 * @param config - 已解析配置。
 * @param signal - 当前 turn 的取消信号。
 * @returns 本次干预剪去/清理的节点数。
 */
export async function interveneBeforeStep(
  agent: Agent,
  platform: Platform,
  config: ResolvedConfig,
  signal: AbortSignal,
): Promise<{ pruned: number; pollution: number; tokensBefore: number }> {
  const session: Session = agent.session
  let tokensBefore = 0
  try {
    tokensBefore = platform.measure(session).totalTokens
  } catch (error) {
    platform.log.debug('pre-step measure failed: %s', messageOf(error))
    return { pruned: 0, pollution: 0, tokensBefore }
  }
  const level = pressureLevel(tokensBefore, config)
  // 压力不足或只到 watch：不干预。
  if (!shouldPrune(level)) return { pruned: 0, pollution: 0, tokensBefore }

  let nodes: SurfaceNodeView[]
  try {
    nodes = platform.project(session)
  } catch (error) {
    platform.log.warn('pre-step project failed: %s', messageOf(error))
    return { pruned: 0, pollution: 0, tokensBefore }
  }
  const scan = scanSurface(nodes, {
    toolResultCharLimit: config.toolResultCharLimit,
    protectRecentMessages: config.protectRecentMessages,
    protectKeywords: config.protectKeywords,
    pruneToolResults: config.pruneToolResults,
    pollutionCleanup: config.pollutionCleanup,
  })

  let pruned = 0
  let pollution = 0
  if (config.pollutionCleanup && shouldCleanPollution(level)) {
    for (const seq of scan.pollutionSeqs) {
      if (signal.aborted) break
      const node = nodes.find((n) => n.seq === seq)
      if (node === undefined) continue
      try {
        if (replacePollution(session, node, node.tokens)) pollution += 1
      } catch (error) {
        platform.log.warn('pre-step pollution replace failed seq=%d: %s', seq, messageOf(error))
      }
    }
  }
  if (config.pruneToolResults) {
    for (const seq of scan.prunableSeqs) {
      if (signal.aborted) break
      const node = nodes.find((n) => n.seq === seq)
      if (node === undefined) continue
      try {
        if (pruneNode(session, node, config.toolResultCharLimit, node.tokens)) pruned += 1
      } catch (error) {
        platform.log.warn('pre-step prune failed seq=%d: %s', seq, messageOf(error))
      }
    }
  }
  if (pruned > 0 || pollution > 0) {
    platform.log.info('pre-step intervention: pruned=%d pollution=%d tokensBefore=%d', pruned, pollution, tokensBefore)
  }
  return { pruned, pollution, tokensBefore }
}

/**
 * 上下文溢出恢复（agent/request-error 用）：模型请求因 CONTEXT_WINDOW_EXCEEDED
 * 失败后，强制做一次剪枝 + 定点压缩，让请求可以重试。
 * 对齐官方 compaction-basic 的溢出恢复路径。
 * @param agent - 请求失败的 agent。
 * @param platform - 平台能力闭包。
 * @param config - 已解析配置。
 * @param signal - turn 取消信号。
 * @returns 是否完成了可重试的恢复（true 表示调用方应返回 { kind: 'retry' }）。
 */
export async function recoverFromOverflow(
  agent: Agent,
  platform: Platform,
  config: ResolvedConfig,
  signal: AbortSignal,
): Promise<boolean> {
  const session: Session = agent.session
  // 1. 零成本剪枝：先清掉超长工具结果。
  try {
    await interveneBeforeStep(agent, platform, { ...config, compactTokens: 0, criticalTokens: 0 }, signal)
  } catch (error) {
    platform.log.warn('overflow prune failed: %s', messageOf(error))
  }
  if (signal.aborted) return false

  // 2. 强制选一个区间压缩（溢出场景忽略最低节省量，尽力而为）。
  let latestNodes: SurfaceNodeView[]
  try {
    latestNodes = platform.project(session)
  } catch (error) {
    platform.log.warn('overflow project failed: %s', messageOf(error))
    return false
  }
  const retentionRange = trySelectByRetention(session, latestNodes, { ...config, retainTokens: 0 }, platform)
  const best = retentionRange ?? pickBestRange(
    scanSurface(latestNodes, {
      toolResultCharLimit: config.toolResultCharLimit,
      protectRecentMessages: 0,
      protectKeywords: config.protectKeywords,
      pruneToolResults: config.pruneToolResults,
      pollutionCleanup: false,
    }).compressibleRanges,
    0,
  )
  if (best === undefined || signal.aborted) return false
  try {
    const ctx: CompactionAgentContext = { session, options: { ...agent.options } }
    await platform.compactRegion(best.start, best.end, ctx, signal)
    platform.log.info('overflow recovery compacted %d..%d', best.start, best.end)
    return true
  } catch (error) {
    platform.log.warn('overflow recovery compact failed: %s', messageOf(error))
    return false
  }
}