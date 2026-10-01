/**
 * 投影层：把 Session 的当前表面 + token 测量结果投影为轻量 {@link SurfaceNodeView}。
 *
 * 这是纯函数层与 Cordis/Session 运行时之间的唯一适配点：value-scan 只消费视图，
 * 便于脱离运行时单测。role 判定以事件 type 为准（source.kind 用于区分 tool），
 * 兼容 user/assistant/tool 三类表面消息。
 * @module @dsh-my-plugin/context-guardian/project
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { isSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { NodeRole, SurfaceNodeView } from './types.ts'
import { extractText } from './execute.ts'

/** 从消息源判定角色（兼容 ToolResultMessage.role='user' 的形态，靠 source.kind 区分）。 */
function roleOf(message: Message): NodeRole {
  if (message.source.kind === 'tool') return 'tool'
  return message.role === 'assistant' ? 'assistant' : 'user'
}

/** 提取工具结果文本与错误标记（tool 节点专用）。 */
function toolFacts(message: Message): { text: string; isError: boolean } {
  // ToolResultMessage 的 content 是 [ToolResultBlock]；非 text 的工具内容按空处理。
  const blocks = message.content
  let text = ''
  let isError = false
  for (const block of blocks) {
    switch (block.type) {
      case 'tool-result':
        isError = block.isError ?? false
        text = extractText(block.content)
        break
      case 'text':
        text += block.text
        break
      default:
        break
    }
  }
  return { text, isError }
}

/** 提取非工具消息文本。 */
function plainText(message: Message): string {
  return extractText(message.content)
}

/**
 * 纯函数：由一条 surface 事件投影出节点视图（无 token 时 tokens=0）。
 * @param event - 表面事件（user/message、assistant/message、tool/result 等）。
 * @param seq - 事件 seq（表面位置）。
 * @param message - 由事件派生出的模型消息。
 * @returns 节点视图；非消息事件返回 undefined。
 */
export function projectEvent(event: SessionEvent, message: Message): SurfaceNodeView | undefined {
  const role = roleOf(message)
  if (role === 'tool') {
    const { text, isError } = toolFacts(message)
    return { seq: event.seq, role, text, tokens: 0, isError }
  }
  return { seq: event.seq, role, text: plainText(message), tokens: 0 }
}

/**
 * 把 token 测量结果按 seq 合并到节点视图上。
 * @param nodes - 节点视图（tokens 当前为 0）。
 * @param measurement - tokenMeter.measure 的结果。
 * @returns 填充了每节点 token 估算的新数组。
 */
export function attachTokens(
  nodes: readonly SurfaceNodeView[],
  measurement: TokenMeasurement,
): SurfaceNodeView[] {
  const bySeq = new Map<number, number>()
  for (const node of measurement.nodes) {
    bySeq.set(node.seq, node.tokens)
  }
  return nodes.map((node) => ({ ...node, tokens: bySeq.get(node.seq) ?? 0 }))
}

/**
 * 从 Session 当前表面投影节点视图序列（按表面 head→tail 顺序）。
 *
 * rc.8 类型暴露 `surface.nodes`（表面位置 seq）与 `events`（全量事件），但未暴露
 * 按 seq 取事件的便捷方法，因此这里按表面位置在事件列表中线性查找——巡检频率低
 * （去抖 15s+），线性成本可接受。
 * @param session - 目标会话。
 * @param measurement - token 测量结果（提供每节点 tokens）。
 * @returns 节点视图序列。
 */
export function projectSurface(session: Session, measurement: TokenMeasurement): SurfaceNodeView[] {
  const bySeq = new Map<number, SessionEvent>()
  for (const event of session.events) {
    bySeq.set(event.seq, event)
  }

  const views: SurfaceNodeView[] = []
  for (const seq of session.surface.nodes) {
    const event = bySeq.get(seq)
    if (event === undefined || !isSurfaceEvent(event)) continue
    const message = session.deriveEventMessage(event)
    if (message === null) continue
    const view = projectEvent(event, message)
    if (view !== undefined) views.push(view)
  }
  return attachTokens(views, measurement)
}