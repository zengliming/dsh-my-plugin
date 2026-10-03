/**
 * 可观测性持久化：$DSH_HOME/observability/ 下 JSON 原子写 + 容错读。
 *
 * 沿用社区先例（dsh-pet 的 pet.json）：write-temp + rename 保证原子性；
 * 损坏/缺失文件回退为空存储；保留事件上限防文件无限膨胀（默认 10000 条，
 * 超出时保留最近 N 条，历史聚合不丢——统计从事件折叠而来，丢弃旧事件只
 * 影响历史明细，聚合层可按天分文件规避）。
 *
 * fs 操作集中在 io.ts，本模块保持可测（注入存储目录与读写函数）。
 * @module @dsh-my-plugin/observability/persist
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import type { ObsEvent, PersistStore } from './types.ts'

/** 保留事件上限：超出后丢弃最旧事件，控制文件体积。 */
export const MAX_EVENTS = 10_000

/** 解析 DSH_HOME（环境变量优先，否则 ~/.dsh），与社区 resolveDshHome 一致。 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const expanded = raw.trim().startsWith('~/') ? join(home, raw.trim().slice(2)) : raw.trim()
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
  }
  return join(home, '.dsh')
}

/** 观测数据目录：$DSH_HOME/observability。 */
export function observabilityDir(dshHome = resolveDshHome()): string {
  return join(dshHome, 'observability')
}

/** 事件文件路径：$DSH_HOME/observability/events.json。 */
export function eventsFile(dshHome = resolveDshHome()): string {
  return join(observabilityDir(dshHome), 'events.json')
}

/** 空存储。 */
export function emptyStore(): PersistStore {
  return { version: 1, events: [] }
}

/** 同步读事件存储；文件缺失或损坏时回退为空存储（容错读）。 */
export function loadEvents(file: string): ObsEvent[] {
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as PersistStore
    if (!Array.isArray(parsed.events)) return []
    return parsed.events.filter(isPlausibleEvent)
  } catch {
    return []
  }
}

/** 校验单条事件的形状（宽松过滤，坏记录跳过而非整体丢弃）。 */
function isPlausibleEvent(value: unknown): value is ObsEvent {
  if (typeof value !== 'object' || value === null) return false
  const event = value as Partial<ObsEvent>
  return typeof event.plugin === 'string' && typeof event.kind === 'string' && typeof event.ts === 'number'
}

/**
 * 同步写事件存储（原子：写 tmp 后 rename）。
 * @param file - 目标文件路径。
 * @param events - 事件列表（调用方已裁剪上限）。
 */
export function saveEvents(file: string, events: readonly ObsEvent[]): void {
  const dir = file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1) || '.'
  mkdirSync(dir, { recursive: true })
  const store: PersistStore = { version: 1, events }
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(store), 'utf8')
  renameSync(tmp, file)
}

/**
 * 纯函数：追加一条事件并按上限裁剪（保留最近 MAX_EVENTS 条）。
 * @param events - 现有事件。
 * @param event - 新事件。
 * @returns 追加并裁剪后的列表。
 */
export function appendBounded(events: readonly ObsEvent[], event: ObsEvent): ObsEvent[] {
  const next = [...events, event]
  if (next.length <= MAX_EVENTS) return next
  return next.slice(next.length - MAX_EVENTS)
}