/**
 * 价值扫描：决定哪些节点受保护、哪些区间可压缩、哪些节点可剪枝、哪些是污染。
 *
 * 全部为纯函数，只消费 {@link SurfaceNodeView}，不依赖 Cordis 运行时。
 * 规则：
 *  - 高价值：用户消息中的指令/问题（较短、含关键词、非噪音）、最近的 N 条消息、
 *    含保护关键词的节点、替代节点（压缩摘要本身）——全部受保护；
 *  - 可剪枝：超长工具结果（超过字符上限，且不含保护关键词）；
 *  - 污染：连续失败的工具结果堆积（仅保留最后一次）、超长且低信息密度的文本；
 *  - 可压缩：介于保护区间之间的低价值区间（user 指令 + assistant 过程 + 工具结果）。
 * @module @dsh-my-plugin/context-guardian/scan
 */

import type { RangeEstimate, ScanResult, SurfaceNodeView } from './types.ts'

/** 污染启发式：一段文本中重复行占比超过该比例视为噪音。 */
const DUPLICATE_LINE_RATIO = 0.5
/** 污染启发式：连续失败工具结果超过该数量才视为堆积。 */
const FAILURE_STREAK = 3

/**
 * 判定单节点是否命中保护关键词（子串匹配，大小写不敏感）。
 * @param text - 节点文本。
 * @param keywords - 保护关键词列表。
 * @returns 命中任一关键词则为 true。
 */
export function matchesProtectedKeyword(text: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return false
  const lower = text.toLowerCase()
  return keywords.some((keyword) => keyword.length > 0 && lower.includes(keyword.toLowerCase()))
}

/**
 * 判定一段文本是否为低信息密度噪音（重复行占比高）。
 * @param text - 待检测文本。
 * @returns 是否为噪音。
 */
export function isNoisyText(text: string): boolean {
  if (text.length < 200) return false
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 4) return false
  const seen = new Map<string, number>()
  for (const line of lines) {
    const key = line.trim()
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  let duplicates = 0
  for (const count of seen.values()) {
    if (count > 1) duplicates += count - 1
  }
  return duplicates / lines.length >= DUPLICATE_LINE_RATIO
}

/** 单次扫描的中间状态。 */
interface ScanState {
  nodes: readonly SurfaceNodeView[]
  protectedSeqs: Set<number>
  prunableSeqs: number[]
  pollutionSeqs: number[]
  failureStreak: number
  lastFailureSeq: number
}

/**
 * 纯函数：对表面节点做价值扫描。
 * @param nodes - 表面节点视图（head→tail 顺序）。
 * @param options - 扫描参数。
 * @returns 保护/剪枝/污染/可压缩区间的完整决策。
 */
export function scanSurface(
  nodes: readonly SurfaceNodeView[],
  options: {
    toolResultCharLimit: number
    protectRecentMessages: number
    protectKeywords: readonly string[]
    pruneToolResults: boolean
    pollutionCleanup: boolean
  },
): ScanResult {
  const state: ScanState = {
    nodes,
    protectedSeqs: new Set(),
    prunableSeqs: [],
    pollutionSeqs: [],
    failureStreak: 0,
    lastFailureSeq: -1,
  }

  // 1. 保护最近 N 条消息（无论角色）。
  const protectFrom = Math.max(0, nodes.length - options.protectRecentMessages)
  for (let i = protectFrom; i < nodes.length; i++) {
    state.protectedSeqs.add(nodes[i]!.seq)
  }

  // 2. 单节点判定：关键词 / 用户指令 / 替代节点保护；剪枝与污染分类。
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!
    if (matchesProtectedKeyword(node.text, options.protectKeywords)) {
      state.protectedSeqs.add(node.seq)
    }
    if (node.isReplacement) {
      state.protectedSeqs.add(node.seq)
    }

    if (node.role === 'user') {
      // 用户消息：较短的指令性文本视为高价值（防止压缩吞掉任务目标）。
      const trimmed = node.text.trim()
      if (trimmed.length > 0 && trimmed.length <= 600) state.protectedSeqs.add(node.seq)
      continue
    }

    if (node.role === 'tool') {
      if (node.isError) {
        state.failureStreak += 1
        state.lastFailureSeq = node.seq
        if (state.failureStreak >= FAILURE_STREAK && options.pollutionCleanup) {
          state.pollutionSeqs.push(node.seq)
        }
      } else {
        state.failureStreak = 0
      }
      if (options.pruneToolResults && node.text.length > options.toolResultCharLimit) {
        state.prunableSeqs.push(node.seq)
      }
    }
  }

  // 3. 由已收集的决策计算可压缩区间：连续的非保护节点组成低价值区间。
  //    至少 2 个节点才成区间（单个节点用剪枝/替换更合适）。
  const protectedSet = state.protectedSeqs
  const compressibleRanges: RangeEstimate[] = []
  let rangeStart = -1
  let rangeEnd = -1
  let rangeTokens = 0

  const closeRange = () => {
    if (rangeStart !== -1 && rangeEnd - rangeStart >= 1 && rangeTokens > 0) {
      compressibleRanges.push({ start: rangeStart, end: rangeEnd, savingsTokens: rangeTokens })
    }
    rangeStart = -1
    rangeEnd = -1
    rangeTokens = 0
  }

  for (const node of nodes) {
    if (protectedSet.has(node.seq)) {
      closeRange()
      continue
    }
    if (rangeStart === -1) rangeStart = node.seq
    rangeEnd = node.seq
    rangeTokens += node.tokens
  }
  closeRange()

  return {
    nodes,
    protectedSeqs: [...state.protectedSeqs],
    compressibleRanges: compressibleRanges.map(({ start, end, savingsTokens }) => ({ start, end, savingsTokens })),
    prunableSeqs: state.prunableSeqs,
    pollutionSeqs: state.pollutionSeqs,
  }
}

/**
 * 纯函数：从可压缩区间里选出最值得压缩的一个（token 节省最大、范围最小优先）。
 * @param ranges - 全部可压缩区间。
 * @param minSavingsTokens - 低于该节省量则不压缩（避免抖动）。
 * @returns 选中的区间，或 undefined（不值得压缩）。
 */
export function pickBestRange(
  ranges: readonly RangeEstimate[],
  minSavingsTokens: number,
): RangeEstimate | undefined {
  let best: RangeEstimate | undefined
  for (const range of ranges) {
    if (range.savingsTokens < minSavingsTokens) continue
    if (best === undefined) {
      best = range
      continue
    }
    // 优先节省多；节省相近时取范围小（风险低）。
    if (
      range.savingsTokens > best.savingsTokens
      || (range.savingsTokens === best.savingsTokens && range.end - range.start < best.end - best.start)
    ) {
      best = range
    }
  }
  return best
}