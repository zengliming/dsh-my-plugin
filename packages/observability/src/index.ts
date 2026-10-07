/**
 * 可观测性核心：统一的记录器与查询层。
 *
 * 用法（插件内）：
 * ```ts
 * import { createObservability } from '@dsh-my-plugin/observability'
 * const obs = createObservability({ plugin: '@dsh-my-plugin/context-guardian' })
 * obs.record({ kind: 'prune', ok: true, tokensSaved: 1200, charsSaved: 4800 })
 * const stats = obs.stats()          // 按动作类别聚合（含未落盘事件）
 * obs.summarize(logger)              // 日志汇总一行
 * obs.flush()                        // 强制落盘（插件卸载时调用）
 * ```
 *
 * 持久化：写入 $DSH_HOME/observability/events.json（JSONL 每行一条，多写者追加安全；
 * 旧版 {version, events} 快照自动迁移；上限 1 万条，超限原子裁剪保留最近 N 条）。
 * 写盘按批量阈值与时间间隔节流（FLUSH_BATCH_SIZE / FLUSH_INTERVAL_MS），只在调用
 * 路径上判定、不引入定时器，避免在工具热路径上频繁落盘；flush() 可强制落盘。所有
 * 写操作同步且容错：record 永不抛错、事件始终进入内存权威列表，落盘失败由 flush
 * 按间隔静默退避重试，绝不影响插件主流程。
 * @module @dsh-my-plugin/observability
 */

import type { Logger } from '@deepseek-ai/cordis'
import type { ObsEvent, PluginStats } from './types.ts'
import { aggregateEvents, emptyKindStats, pluginStatsOf } from './types.ts'
import {
  eventsFile, loadEvents, appendBounded, appendEvents, saveEvents, resolveDshHome, migrateLegacyStore, MAX_EVENTS,
} from './persist.ts'

export type { ObsEvent, ActionKind, PluginId, KindStats, PluginStats } from './types.ts'
export { aggregateEvents, pluginStatsOf, emptyKindStats } from './types.ts'
export { resolveDshHome, observabilityDir, eventsFile, MAX_EVENTS } from './persist.ts'

/** 批量写盘阈值：待落盘队列达到该条数即触发写盘。 */
export const FLUSH_BATCH_SIZE = 50
/** 批量写盘间隔：距上次落盘超过该毫秒数即触发写盘（与批量阈值取或）。 */
export const FLUSH_INTERVAL_MS = 1000

/** 记录器配置。 */
export interface ObservabilityOptions {
  /** 本插件的包名（写入每条事件）。 */
  plugin: string
  /** 覆盖事件文件路径（测试注入）。 */
  file?: string
  /** 覆盖"当前时间"函数（测试注入）。 */
  now?: () => number
}

/** 记录器接口（插件只见此面）。 */
export interface Observability {
  /** 记录一条事件：先入内存权威列表，再按批量/间隔节流落盘。永不抛错；仅当事件构造异常时返回 false，落盘失败静默退避。 */
  record(event: Omit<ObsEvent, 'plugin' | 'ts'> & { plugin?: string; ts?: number }): boolean
  /** 强制把内存权威事件列表写盘（卸载前调用）。写失败不抛错，按间隔退避重试。 */
  flush(): void
  /** 全部事件（内存权威列表，含未落盘事件，按到达顺序）。 */
  all(): ObsEvent[]
  /** 按动作类别聚合的效果统计（含未落盘事件）。 */
  stats(): PluginStats[]
  /** 日志汇总：把统计打印为一行可读摘要。 */
  summarize(logger: Logger): void
}

/**
 * 创建记录器。首次调用会加载持久化历史，之后的 record 追加进内存权威列表，并在
 * 达到批量阈值（FLUSH_BATCH_SIZE）或距上次落盘超过间隔（FLUSH_INTERVAL_MS）时
 * 节流写盘；需要立即落盘时调用 flush()。
 * @param options - 配置。
 * @returns 记录器实例。
 */
export function createObservability(options: ObservabilityOptions): Observability {
  const plugin = options.plugin
  const file = options.file ?? eventsFile()
  const now = options.now ?? (() => Date.now())
  // 持久化历史是唯一权威（内存不重复持有，避免跨重启重复累积）。
  let persisted = loadEvents(file)
  // 旧版 {version, events} 快照创建期一次性迁移为 JSONL（失败静默：读取侧兼容混合格式）。
  try {
    migrateLegacyStore(file)
  } catch {
    // 迁移失败不影响使用（读取侧已兼容旧格式/混合格式）。
  }
  // 磁盘行数估计：创建时 = 刚读取的事件数；追加时精确递增，裁剪后重置。
  // 用于判断是否触发上限裁剪（避免每次 flush 全量读文件核对）。
  let diskCount = persisted.length
  // 待落盘队列：record 追加后入队，由 maybeFlush 按批量/间隔节流真正写盘。
  // 事件本体始终以 persisted 为准，pending 只用于批量阈值计数。
  let pending: ObsEvent[] = []
  // 上次落盘（含失败的尝试）时间。初始 0：首次 record 时距上次落盘已超过间隔，
  // 会立即落盘——保持旧行为，批量延迟只作用于同一突发窗口内的后续记录。
  let lastFlushAt = 0
  // 上次落盘是否失败：失败后按间隔退避，避免磁盘持续故障时每次 record 都重试（忙循环）。
  let lastFlushFailed = false

  /** 强制把内存权威事件列表写盘（JSONL 追加，多写者安全）。写失败不抛错：保留 pending，事件仍完整保留在内存 persisted 中。 */
  const flush: Observability['flush'] = () => {
    // 无积压事件时短路：成功落盘后文件已包含 persisted 的全部增量（pending 为空即无增量）。
    if (pending.length === 0) return
    try {
      const appended = appendEvents(file, pending)
      pending = []
      lastFlushAt = now()
      lastFlushFailed = false
      diskCount += appended
      // 磁盘行数超过上限才裁剪（读当前文件合并后再裁剪，避免覆盖其他实例刚追加的事件）。
      // 单写者场景下约每 10050→10000 条触发一次重写，摊销 O(1)。
      if (diskCount > MAX_EVENTS) compact()
    } catch {
      // 失败退避：推进 lastFlushAt，让后续 maybeFlush 按间隔节奏重试（而非每次 record 都试）；
      // pending 原样保留、事件不丢（内存权威列表完整），下次 flush()/maybeFlush() 重试追加。
      lastFlushAt = now()
      lastFlushFailed = true
    }
  }

  /** 磁盘文件裁剪：读当前文件（含其他实例的追加），仅保留最近 MAX_EVENTS 条后原子重写。 */
  const compact = (): void => {
    try {
      const onDisk = loadEvents(file)
      const trimmed = onDisk.slice(-MAX_EVENTS)
      saveEvents(file, trimmed)
      diskCount = trimmed.length
    } catch {
      // 裁剪失败不影响数据完整性（仅文件体积略超上限），静默忽略。
    }
  }

  /** 节流判定：达到批量阈值或距上次落盘超过间隔时真正写盘。 */
  const maybeFlush = (): void => {
    const elapsed = now() - lastFlushAt
    const byBatch = pending.length >= FLUSH_BATCH_SIZE
    const byInterval = elapsed >= FLUSH_INTERVAL_MS
    // 批量触发要求上次落盘成功（失败后由间隔分支按退避节奏重试），防止忙循环。
    if ((byBatch && !lastFlushFailed) || byInterval) {
      flush()
    }
  }

  const record: Observability['record'] = (input) => {
    try {
      const event: ObsEvent = {
        plugin: input.plugin ?? plugin,
        kind: input.kind,
        ts: input.ts ?? now(),
        ok: input.ok,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.tokensSaved !== undefined ? { tokensSaved: input.tokensSaved } : {}),
        ...(input.charsSaved !== undefined ? { charsSaved: input.charsSaved } : {}),
        ...(input.count !== undefined ? { count: input.count } : {}),
        ...(input.pressureLevel !== undefined ? { pressureLevel: input.pressureLevel } : {}),
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(input.extra !== undefined ? { extra: input.extra } : {}),
      }
      // 持久化按增量追加（只加新事件，不重合并，避免重复累积）。
      persisted = appendBounded(persisted, event)
      pending.push(event)
      maybeFlush()
      return true
    } catch {
      return false
    }
  }

  const all: Observability['all'] = () => {
    return [...persisted]
  }

  const stats: Observability['stats'] = () => {
    return pluginStatsOf(aggregateEvents(all()))
  }

  const summarize: Observability['summarize'] = (logger) => {
    const mine = stats().find((s) => s.plugin === plugin)
    if (mine === undefined) {
      logger.debug(`${plugin}: no observations yet`)
      return
    }
    const t = mine.total
    logger.info(
      `${plugin} effects: ${t.count} actions (${t.success} ok / ${t.failure} fail), `
      + `saved ~${t.tokensSaved} tokens, ${t.charsSaved} chars`,
    )
  }

  return { record, all, stats, summarize, flush }
}

/** 便捷函数：合并两个统计数组（同一插件的统计相加），供汇总展示。 */
export function mergeStats(a: readonly PluginStats[], b: readonly PluginStats[]): PluginStats[] {
  const byPlugin = new Map<string, PluginStats>()
  for (const stats of [...a, ...b]) {
    const existing = byPlugin.get(stats.plugin)
    if (existing === undefined) {
      byPlugin.set(stats.plugin, stats)
      continue
    }
    const mergedTotal = {
      count: existing.total.count + stats.total.count,
      success: existing.total.success + stats.total.success,
      failure: existing.total.failure + stats.total.failure,
      tokensSaved: existing.total.tokensSaved + stats.total.tokensSaved,
      charsSaved: existing.total.charsSaved + stats.total.charsSaved,
    }
    byPlugin.set(stats.plugin, { plugin: stats.plugin, byKind: { ...existing.byKind, ...stats.byKind }, total: mergedTotal })
  }
  return [...byPlugin.values()]
}