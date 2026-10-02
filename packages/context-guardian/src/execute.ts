/**
 * 执行层：把价值扫描的决策落到 Session 表面。
 *
 * 所有改动都通过 Session 的官方 append + surfaceOp replace 机制完成，与平台
 * 压缩使用同一套表面替换协议（见 @deepseek-ai/dsh-session 的 SurfaceIntent）。
 *
 * 对齐官方 tool-result-pruner 的两个协议：
 *  - 影子价格：每次替换前 append 一条 `compaction/prune`（log-only）事件，记录被
 *    遮蔽节点的 token 价格，token 计量因此能正确扣减被替换的内容；
 *  - 原事件类型：工具结果节点用 `tool/result` 事件替换（保留 callId 配对语义），
 *    其他节点用 `user/message` 承载文本。
 *
 * 执行层本身是纯逻辑与 Session 的薄胶水——每个操作单独 try/catch，失败只记日志，
 * 绝不让插件异常冒泡到 DSH。
 * @module @dsh-my-plugin/context-guardian/execute
 */

import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, ToolResultMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SurfaceNodeView } from './types.ts'

/** 剪枝后保留的文本比例（工具结果只留头部与尾部关键信息）。 */
const PRUNE_HEAD_RATIO = 0.2
const PRUNE_TAIL_RATIO = 0.2
/** 剪枝标记，让后续扫描识别这是替代节点（受保护，不再二次剪枝）。 */
export const PRUNE_MARKER = '[context-guardian: pruned]'
/** 污染替换的占位文本。 */
export const POLLUTION_MARKER = '[context-guardian: removed noise]'

/**
 * 提取 ContentBlock[] 中的纯文本（text 块拼接；其他块忽略，未知类型安全跳过）。
 * @param blocks - 消息内容块。
 * @returns 拼接后的文本。
 */
export function extractText(blocks: readonly ContentBlock[]): string {
  let out = ''
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        out += block.text
        break
      default:
        // 未知/未来扩展的块类型：跳过，保证向前兼容。
        break
    }
  }
  return out
}

/** number → SessionSeq 品牌化转换（DSH 的 seq 是 branded number）。 */
function seq(value: number): SessionSeq {
  return value as SessionSeq
}

/**
 * 按 Unicode 码点切片（不劈开代理对：emoji/生僻字为双 UTF-16 单元）。
 * 与官方 tool-result-pruner 一致，保证中文与 emoji 边界完整。
 * @param text - 原始文本。
 * @param start - 起（码点序号，含）。
 * @param end - 止（码点序号，不含）。
 * @returns 切片后的文本。
 */
export function sliceByCodePoint(text: string, start: number, end: number): string {
  return Array.from(text).slice(start, end).join('')
}

/**
 * 纯函数：对一段文本做头/尾保留剪枝。按 Unicode 码点测量与切片，
 * 剪枝边界只能落在完整码点之间（不劈开代理对）。
 * @param text - 原始文本。
 * @param charLimit - 超过该码点数才剪。
 * @returns 剪枝后的文本（未超限则原样返回）。
 */
export function trimText(text: string, charLimit: number): string {
  const totalPoints = Array.from(text).length
  if (totalPoints <= charLimit) return text
  const head = Math.floor(charLimit * PRUNE_HEAD_RATIO)
  const tail = Math.floor(charLimit * PRUNE_TAIL_RATIO)
  const keep = head + tail
  if (keep >= totalPoints) return text
  const headPart = sliceByCodePoint(text, 0, head)
  const tailPart = sliceByCodePoint(text, totalPoints - tail, totalPoints)
  return `${PRUNE_MARKER}\n${headPart}\n…[${totalPoints - keep} chars trimmed]…\n${tailPart}`
}

/** 生成污染占位文本（保留失败工具结果的基本信息）。 */
export function pollutionReplacement(node: SurfaceNodeView): string {
  const tool = node.toolName ? ` tool=${node.toolName}` : ''
  const role = node.role === 'tool' ? `tool result${tool}` : node.role
  return `${POLLUTION_MARKER} ${role} suppressed${node.isError ? ' (repeated failure)' : ''}`
}

/**
 * 生成一个替代的 UserMessage：压缩/剪枝摘要文本的承载节点。
 * 使用平台 createUserMessage 生成带 id 的合法消息。
 * @param text - 替代文本。
 * @returns UserMessage（surface 替换节点由调用方补充 surfaceOp）。
 */
export function makeReplacementMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/**
 * 替换前发出 `compaction/prune` 影子价格事件（log-only，无 surfaceOp）。
 * 被遮蔽节点的 token 价格由 tokenMeter 估算，纯消费者可据此扣减 token。
 * @param session - 目标会话。
 * @param shadowedSeqs - 被遮蔽的表面节点 seq 列表。
 * @param shadowedTokenCount - 被遮蔽内容估算 token 数。
 * @returns 是否成功落地（失败仅表示计量事件缺失，不阻断替换本身）。
 */
export function shadowPrune(
  session: Session,
  shadowedSeqs: readonly number[],
  shadowedTokenCount: number,
): boolean {
  if (shadowedSeqs.length === 0) return false
  try {
    session.append('compaction/prune', {
      shadowedRange: { start: seq(shadowedSeqs[0]!), end: seq(shadowedSeqs[shadowedSeqs.length - 1]!) },
      shadowedSeqs: shadowedSeqs.map((s) => seq(s)),
      shadowedTokenCount,
    })
    return true
  } catch (error) {
    // 计量事件失败不阻断替换；由调用方记录。
    return false
  }
}

/**
 * 在 Session 上执行一次区间替换：把 [startSeq, endSeq] 的表面节点替换为一条新消息。
 * 工具结果节点用 `tool/result` 事件（保留 callId 配对），其余用 `user/message`。
 * 替换必须同步紧跟所引用的源节点（sourceEventSeqs），这是 surface 替换协议的要求。
 * @param session - 目标会话。
 * @param startSeq - 表面起始位置（含）。
 * @param endSeq - 表面结束位置（含）。
 * @param replacement - 替代消息（user 或 tool-result）。
 * @param sourceEventSeqs - 被替换的源节点 seq 列表。
 * @param shadowedTokenCount - 被遮蔽内容估算 token 数（写入影子价格事件）。
 * @returns 是否成功落地。
 */
export function replaceRange(
  session: Session,
  startSeq: number,
  endSeq: number,
  replacement: UserMessage | ToolResultMessage,
  sourceEventSeqs: readonly number[],
  shadowedTokenCount: number,
): boolean {
  try {
    // 影子价格事件必须先于替换落地（协议要求同步紧跟）。
    shadowPrune(session, sourceEventSeqs, shadowedTokenCount)
    if (replacement.role === 'tool') {
      session.append('tool/result', {
        turn: 0,
        step: 0,
        message: replacement as ToolResultMessage,
      }, {
        surfaceOp: { op: 'replace', startSeq: seq(startSeq), endSeq: seq(endSeq) },
        sourceEventSeqs: sourceEventSeqs.map((s) => seq(s)),
      })
    } else {
      session.append('user/message', replacement as UserMessage, {
        surfaceOp: { op: 'replace', startSeq: seq(startSeq), endSeq: seq(endSeq) },
        sourceEventSeqs: sourceEventSeqs.map((s) => seq(s)),
      })
    }
    return true
  } catch (error) {
    // 替换失败（例如范围已变化）由调用方记录；这里不向上抛。
    return false
  }
}

/** 生成一个替代的 ToolResultMessage：剪枝/污染后的工具结果承载节点（保留 callId）。 */
export function makeToolResultReplacement(
  callId: string,
  text: string,
  isError: boolean,
): ToolResultMessage {
  return createToolResultMessage({
    callId: callId as never,
    content: [{ type: 'text', text }],
    isError,
  })
}

/**
 * 在 Session 上执行单节点剪枝：把单个工具结果替换为头/尾保留文本。
 * 使用 `tool/result` 事件类型保持工具配对语义，并先行发出影子价格事件。
 * @param session - 目标会话。
 * @param node - 被剪枝的节点视图（tool 节点）。
 * @param charLimit - 字符上限。
 * @param shadowedTokenCount - 被遮蔽内容估算 token 数。
 * @returns 是否落地。
 */
export function pruneNode(
  session: Session,
  node: SurfaceNodeView,
  charLimit: number,
  shadowedTokenCount: number,
): boolean {
  const trimmed = trimText(node.text, charLimit)
  if (trimmed === node.text) return false
  const replacement = makeToolResultReplacement(node.toolName ?? 'tool', trimmed, node.isError ?? false)
  return replaceRange(session, node.seq, node.seq, replacement, [node.seq], shadowedTokenCount)
}

/**
 * 在 Session 上执行污染替换：把单个节点替换为占位文本。
 * 工具结果节点用 `tool/result` 类型，其余用 `user/message`。
 * @param session - 目标会话。
 * @param node - 污染节点视图。
 * @param shadowedTokenCount - 被遮蔽内容估算 token 数。
 * @returns 是否落地。
 */
export function replacePollution(
  session: Session,
  node: SurfaceNodeView,
  shadowedTokenCount: number,
): boolean {
  const text = pollutionReplacement(node)
  if (node.role === 'tool') {
    const replacement = makeToolResultReplacement(node.toolName ?? 'tool', text, node.isError ?? false)
    return replaceRange(session, node.seq, node.seq, replacement, [node.seq], shadowedTokenCount)
  }
  return replaceRange(session, node.seq, node.seq, makeReplacementMessage(text), [node.seq], shadowedTokenCount)
}