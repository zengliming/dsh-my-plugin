/**
 * 可观测性模型：统一的事件类型与指标定义。
 *
 * 所有 @dsh-my-plugin/* 插件用同一套事件模型上报效果数据，聚合层据此生成
 * 可对比的统计，支撑后续优化（阈值调整、策略取舍）。
 * @module @dsh-my-plugin/observability/types
 */

/** 事件源插件标识。 */
export type PluginId = '@dsh-my-plugin/context-guardian' | '@dsh-my-plugin/hello-world' | (string & {})

/** 动作类别：剪枝 / 压缩 / 污染清理 / 溢出恢复 / 工具调用 / 其他。 */
export type ActionKind =
  | 'prune'
  | 'compact'
  | 'pollution-cleanup'
  | 'overflow-recovery'
  | 'tool-call'
  | 'inspect'
  | 'error'
  | (string & {})

/** 一次观测事件（统一形状，字段按动作类别可选填充）。 */
export interface ObsEvent {
  /** 事件源插件（包名）。 */
  readonly plugin: PluginId
  /** 动作类别。 */
  readonly kind: ActionKind
  /** 事件时间（epoch ms）。 */
  readonly ts: number
  /** 会话 id（可空：非会话级动作）。 */
  readonly sessionId?: string
  /** 是否成功。 */
  readonly ok: boolean
  /** 节省的 token 数（剪枝/压缩的关键指标）。 */
  readonly tokensSaved?: number
  /** 节省的字符数（剪枝的关键指标）。 */
  readonly charsSaved?: number
  /** 处理的消息数 / 工具调用次数。 */
  readonly count?: number
  /** 压力分级（compact/prune 等动作附带）。 */
  readonly pressureLevel?: string
  /** 动作细节（范围、区间等）。 */
  readonly detail?: string
  /** 扩展字段（插件自定义）。 */
  readonly extra?: Record<string, unknown>
}

/** 按动作类别聚合的摘要。 */
export interface KindStats {
  /** 总次数。 */
  readonly count: number
  /** 成功次数。 */
  readonly success: number
  /** 失败次数。 */
  readonly failure: number
  /** 累计节省 token。 */
  readonly tokensSaved: number
  /** 累计节省字符。 */
  readonly charsSaved: number
}

/** 按插件聚合的效果统计（query 层的返回形状）。 */
export interface PluginStats {
  readonly plugin: PluginId
  /** 按动作类别的聚合。 */
  readonly byKind: Record<string, KindStats>
  /** 全部动作合计。 */
  readonly total: KindStats
}

/** 持久化文件的内容结构。 */
export interface PersistStore {
  readonly version: 1
  /** 已保留的事件（按到达顺序）。 */
  readonly events: readonly ObsEvent[]
}

/** 空统计工厂。 */
export function emptyKindStats(): KindStats {
  return { count: 0, success: 0, failure: 0, tokensSaved: 0, charsSaved: 0 }
}

/**
 * 纯函数：把一条事件折叠进按动作类别的聚合（不改传入对象，返回新聚合）。
 * @param stats - 现有聚合。
 * @param event - 待折叠事件。
 * @returns 折叠后的新聚合。
 */
export function foldEvent(stats: KindStats, event: ObsEvent): KindStats {
  return {
    count: stats.count + 1,
    success: stats.success + (event.ok ? 1 : 0),
    failure: stats.failure + (event.ok ? 0 : 1),
    tokensSaved: stats.tokensSaved + (event.tokensSaved ?? 0),
    charsSaved: stats.charsSaved + (event.charsSaved ?? 0),
  }
}

/** 内部可变聚合形状（foldEvent 的累加载体）。 */
interface MutableStats {
  count: number
  success: number
  failure: number
  tokensSaved: number
  charsSaved: number
}

/** 把内部可变形状转为稳定的 KindStats。 */
function freezeStats(m: MutableStats): KindStats {
  return { count: m.count, success: m.success, failure: m.failure, tokensSaved: m.tokensSaved, charsSaved: m.charsSaved }
}

/**
 * 纯函数：把一组事件聚合为按插件 + 动作类别的统计。
 * @param events - 事件列表。
 * @returns 插件到（动作类别 → 聚合）的映射。
 */
export function aggregateEvents(events: readonly ObsEvent[]): Map<PluginId, Map<string, KindStats>> {
  const byPlugin = new Map<PluginId, Map<string, MutableStats>>()
  for (const event of events) {
    let byKind = byPlugin.get(event.plugin)
    if (byKind === undefined) byPlugin.set(event.plugin, (byKind = new Map()))
    let stats = byKind.get(event.kind)
    if (stats === undefined) byKind.set(event.kind, (stats = { count: 0, success: 0, failure: 0, tokensSaved: 0, charsSaved: 0 }))
    stats.count += 1
    if (event.ok) stats.success += 1
    else stats.failure += 1
    stats.tokensSaved += event.tokensSaved ?? 0
    stats.charsSaved += event.charsSaved ?? 0
  }
  const result = new Map<PluginId, Map<string, KindStats>>()
  for (const [plugin, byKind] of byPlugin) {
    const frozen = new Map<string, KindStats>()
    for (const [kind, stats] of byKind) frozen.set(kind, freezeStats(stats))
    result.set(plugin, frozen)
  }
  return result
}

/**
 * 纯函数：把聚合映射转为稳定的 PluginStats 数组。
 * @param byPlugin - aggregateEvents 的输出。
 * @returns 排序后的统计数组。
 */
export function pluginStatsOf(byPlugin: Map<PluginId, Map<string, KindStats>>): PluginStats[] {
  const result: PluginStats[] = []
  for (const [plugin, byKind] of byPlugin) {
    let count = 0
    let success = 0
    let failure = 0
    let tokensSaved = 0
    let charsSaved = 0
    const kindMap: Record<string, KindStats> = {}
    for (const [kind, stats] of byKind) {
      kindMap[kind] = stats
      count += stats.count
      success += stats.success
      failure += stats.failure
      tokensSaved += stats.tokensSaved
      charsSaved += stats.charsSaved
    }
    result.push({
      plugin,
      byKind: kindMap,
      total: { count, success, failure, tokensSaved, charsSaved },
    })
  }
  result.sort((a, b) => b.total.count - a.total.count)
  return result
}