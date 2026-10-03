/**
 * 可观测性核心：统一的记录器与查询层。
 *
 * 用法（插件内）：
 * ```ts
 * import { createObservability } from '@dsh-my-plugin/observability'
 * const obs = createObservability({ plugin: '@dsh-my-plugin/context-guardian' })
 * obs.record({ kind: 'prune', ok: true, tokensSaved: 1200, charsSaved: 4800 })
 * const stats = obs.stats()          // 按动作类别聚合（含持久化历史）
 * obs.summarize(logger)              // 日志汇总一行
 * ```
 *
 * 持久化：写入 $DSH_HOME/observability/events.json（原子写，上限 1 万条）。
 * 所有写操作同步且容错：失败只返回 false，绝不影响插件主流程。
 * @module @dsh-my-plugin/observability
 */

import type { Logger } from '@deepseek-ai/cordis'
import type { ObsEvent, PluginStats } from './types.ts'
import { aggregateEvents, emptyKindStats, pluginStatsOf } from './types.ts'
import { eventsFile, loadEvents, appendBounded, saveEvents } from './persist.ts'
import { resolveDshHome } from './persist.ts'

export type { ObsEvent, ActionKind, PluginId, KindStats, PluginStats } from './types.ts'
export { aggregateEvents, pluginStatsOf, emptyKindStats } from './types.ts'
export { resolveDshHome, observabilityDir, eventsFile, MAX_EVENTS } from './persist.ts'

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
  /** 记录一条事件并持久化。永不抛错；失败返回 false。 */
  record(event: Omit<ObsEvent, 'plugin' | 'ts'> & { plugin?: string; ts?: number }): boolean
  /** 全部事件（内存 + 持久化历史合并，按时间排序）。 */
  all(): ObsEvent[]
  /** 按动作类别聚合的效果统计（含历史）。 */
  stats(): PluginStats[]
  /** 日志汇总：把统计打印为一行可读摘要。 */
  summarize(logger: Logger): void
}

/**
 * 创建记录器。首次调用会加载持久化历史，之后的 record 同步追加并原子写盘。
 * @param options - 配置。
 * @returns 记录器实例。
 */
export function createObservability(options: ObservabilityOptions): Observability {
  const plugin = options.plugin
  const file = options.file ?? eventsFile()
  const now = options.now ?? (() => Date.now())
  // 持久化历史是唯一权威（内存不重复持有，避免跨重启重复累积）。
  let persisted = loadEvents(file)

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
      try {
        saveEvents(file, persisted)
      } catch {
        // 写盘失败不阻断（内存仍保留本次事件）。
      }
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

  return { record, all, stats, summarize }
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