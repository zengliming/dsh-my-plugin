/**
 * 执行层：把价值扫描的决策落到 Session 表面。
 *
 * 所有改动都通过 Session 的官方 append + surfaceOp replace 机制完成，与平台
 * 压缩使用同一套表面替换协议（见 @deepseek-ai/dsh-session 的 SurfaceIntent）。
 * 执行层本身是纯逻辑与 Session 的薄胶水——每个操作单独 try/catch，失败只记日志，
 * 绝不让插件异常冒泡到 DSH。
 * @module @dsh-my-plugin/context-guardian/execute
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
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

/** 供执行层引用：把平台 UserMessage 的 content 规范化为文本视图。 */
export function textOf(message: UserMessage): string {
  return extractText(message.content)
}

/**
 * 纯函数：对一段文本做头/尾保留剪枝。
 * @param text - 原始文本。
 * @param charLimit - 超过该字符数才剪。
 * @returns 剪枝后的文本（未超限则原样返回）。
 */
export function trimText(text: string, charLimit: number): string {
  if (text.length <= charLimit) return text
  const head = Math.floor(charLimit * PRUNE_HEAD_RATIO)
  const tail = Math.floor(charLimit * PRUNE_TAIL_RATIO)
  const keep = head + tail
  if (keep >= text.length) return text
  const headPart = text.slice(0, head)
  const tailPart = text.slice(text.length - tail)
  return `${PRUNE_MARKER}\n${headPart}\n…[${text.length - keep} chars trimmed]…\n${tailPart}`
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
 * 在 Session 上执行一次区间替换：把 [start, end] 的表面节点替换为一条新消息。
 * 替换必须同步紧跟所引用的源节点（sourceEventSeqs），这是 surface 替换协议的要求。
 * @param session - 目标会话。
 * @param start - 表面起始位置（含）。
 * @param end - 表面结束位置（含）。
 * @param text - 替代文本。
 * @param sourceEventSeqs - 被替换的源节点 seq 列表。
 * @returns 是否成功落地。
 */
export function replaceRange(
  session: Session,
  start: number,
  end: number,
  text: string,
  sourceEventSeqs: readonly number[],
): boolean {
  try {
    session.append('user/message', makeReplacementMessage(text), {
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: [...sourceEventSeqs],
    })
    return true
  } catch (error) {
    // 替换失败（例如范围已变化）由调用方记录；这里不向上抛。
    return false
  }
}

/**
 * 在 Session 上执行单节点剪枝（把单个工具结果替换为头/尾保留文本）。
 * @param session - 目标会话。
 * @param node - 被剪枝的节点视图。
 * @param charLimit - 字符上限。
 * @returns 是否落地。
 */
export function pruneNode(session: Session, node: SurfaceNodeView, charLimit: number): boolean {
  const trimmed = trimText(node.text, charLimit)
  if (trimmed === node.text) return false
  return replaceRange(session, node.seq, node.seq, trimmed, [node.seq])
}

/**
 * 在 Session 上执行污染替换（把单个节点替换为占位文本）。
 * @param session - 目标会话。
 * @param node - 污染节点视图。
 * @returns 是否落地。
 */
export function replacePollution(session: Session, node: SurfaceNodeView): boolean {
  return replaceRange(session, node.seq, node.seq, pollutionReplacement(node), [node.seq])
}