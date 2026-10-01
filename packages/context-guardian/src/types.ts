/**
 * 上下文守护者的轻量节点视图与决策类型。
 *
 * 插件不在纯函数层依赖 Cordis/Session 运行时类型：执行层把 Session 事件投影为
 * 这里定义的 {@link SurfaceNodeView}，纯函数只消费视图，从而可以脱离运行时单测。
 * @module @dsh-my-plugin/context-guardian/types
 */

/** 消息角色（surface 节点来源）。 */
export type NodeRole = 'user' | 'assistant' | 'tool'

/** 从 session 表面节点投影出的轻量视图。 */
export interface SurfaceNodeView {
  /** 表面位置序号（与 compaction compactRegion 的 start/end 语义一致）。 */
  readonly seq: number
  /** 消息角色。 */
  readonly role: NodeRole
  /** 文本内容（tool 节点为工具输出文本；无文本则为空串）。 */
  readonly text: string
  /** 该节点在 token 测量中的估算 token 数（来自 tokenMeter.nodes）。 */
  readonly tokens: number
  /** 工具节点专用：工具名。 */
  readonly toolName?: string
  /** 工具节点专用：是否为错误结果。 */
  readonly isError?: boolean
  /** 该节点是否为压缩/剪枝产生的替代节点（compactCheckpointSource 等）。 */
  readonly isReplacement?: boolean
}

/** 一次价值扫描的输出：每个节点的重要度与决策。 */
export interface ScanResult {
  /** 全部节点的视图（与传入顺序一致）。 */
  readonly nodes: readonly SurfaceNodeView[]
  /** 高价值节点序号（受保护，不进入压缩/剪枝范围）。 */
  readonly protectedSeqs: readonly number[]
  /** 建议压缩的低价值区间（闭区间，按表面位置），按需多个。 */
  readonly compressibleRanges: readonly RangeEstimate[]
  /** 建议剪枝的节点（超长工具结果等）。 */
  readonly prunableSeqs: readonly number[]
  /** 检测到的污染节点。 */
  readonly pollutionSeqs: readonly number[]
}

/** 可压缩区间的价值估算：压缩后预计节省的 token。 */
export interface RangeEstimate {
  readonly start: number
  readonly end: number
  /** 区间内非保护节点的 token 之和（潜在节省）。 */
  readonly savingsTokens: number
}

/** 投影函数：把一个 Session 表面节点转为视图（执行层实现，纯函数层不引用）。 */
export type NodeProjector = (seq: number) => SurfaceNodeView | undefined