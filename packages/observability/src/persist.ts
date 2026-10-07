/**
 * 可观测性持久化：$DSH_HOME/observability/ 下 JSONL（每行一条事件）追加写 + 原子裁剪。
 *
 *  - 追加写：多实例（hello-world / context-guardian 各持一个记录器）写同一文件时，
 *    每次 flush 是单次 appendFileSync 系统调用，行粒度互不覆盖——修复旧版
 *    `{version, events}` 全量快照重写时「后写者覆盖先写者」的丢事件问题；
 *  - 兼容旧格式：记录器创建时经 migrateLegacyStore 一次性把 `{version, events}`
 *    单对象快照迁移为 JSONL（失败静默：读取侧兼容旧/混合格式）；
 *  - 容错读：缺失/损坏/混合格式逐行宽松解析，坏行跳过而非整体丢弃；
 *  - 上限：保留 MAX_EVENTS（默认 1 万）条，写路径按磁盘行数精确计数，超限才触发
 *    全量重写（读当前文件合并后再裁剪，不丢其他实例刚追加的事件；write tmp +
 *    rename 保证原子）。单写者下约每 10050→10000 条重写一次，摊销 O(1)。
 *
 * fs 操作集中在本模块，保持可测（测试注入临时目录与文件路径）。
 * @module @dsh-my-plugin/observability/persist
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
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

/** 校验单条事件的形状（宽松过滤，坏记录跳过而非整体丢弃）。 */
function isPlausibleEvent(value: unknown): value is ObsEvent {
  if (typeof value !== 'object' || value === null) return false
  const event = value as Partial<ObsEvent>
  return typeof event.plugin === 'string' && typeof event.kind === 'string' && typeof event.ts === 'number'
}

/** 序列化一条事件为 JSONL 行（不含换行）。 */
export function serializeEvent(event: ObsEvent): string {
  return JSON.stringify(event)
}

/** 解析一行 JSONL；空行/坏行返回 undefined（宽松跳过）。 */
export function parseEventLine(line: string): ObsEvent | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  try {
    const value = JSON.parse(trimmed) as unknown
    return isPlausibleEvent(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** 旧格式文件文本（{version, events} 单对象）→ 事件列表；非旧格式/损坏返回 undefined。 */
function parseLegacyStore(raw: string): ObsEvent[] | undefined {
  try {
    const parsed = JSON.parse(raw) as PersistStore
    // 旧格式包必须带 version: 1 与 events 数组；普通事件对象不会命中（防御性区分）。
    if (parsed.version !== 1 || !Array.isArray(parsed.events)) return undefined
    return parsed.events.filter(isPlausibleEvent)
  } catch {
    return undefined
  }
}

/** 同步读事件存储；缺失/损坏时回退为空（容错读，兼容旧格式与 JSONL/混合格式）。 */
export function loadEvents(file: string): ObsEvent[] {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const trimmed = raw.trim()
  if (trimmed === '') return []
  if (trimmed.startsWith('{')) {
    const legacy = parseLegacyStore(raw)
    if (legacy !== undefined) return legacy
    // 旧对象解析失败（混合/损坏）：不整体放弃，继续逐行解析，旧对象行会被宽松过滤。
  }
  const events: ObsEvent[] = []
  for (const line of raw.split(/\r?\n/)) {
    const event = parseEventLine(line)
    if (event !== undefined) events.push(event)
  }
  return events
}

/** 文件所在目录（'' 或含尾部分隔符），供 mkdir -p 用。 */
function dirOf(file: string): string {
  return file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1) || '.'
}

/**
 * 旧格式单次迁移：文件若为 {version, events} 单对象，原地改写为 JSONL。
 * 在记录器创建时调用一次（避免每次追加都读全文件嗅探格式）。
 * @param file - 目标文件路径。
 * @returns 是否发生了迁移（旧格式 → JSONL）；非旧格式/不可读返回 false。
 */
export function migrateLegacyStore(file: string): boolean {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return false
  }
  const trimmed = raw.trim()
  if (trimmed === '' || !trimmed.startsWith('{')) return false
  const legacy = parseLegacyStore(raw)
  if (legacy === undefined) return false
  saveEvents(file, legacy)
  return true
}

/**
 * 追加写一批事件（JSONL，单次 appendFileSync，行粒度互不覆盖）。
 * @param file - 目标文件路径。
 * @param events - 待追加事件（按到达顺序）。
 * @returns 实际追加的行数（= events.length）。
 */
export function appendEvents(file: string, events: readonly ObsEvent[]): number {
  if (events.length === 0) return 0
  mkdirSync(dirOf(file), { recursive: true })
  appendFileSync(file, events.map(serializeEvent).join('\n') + '\n', 'utf8')
  return events.length
}

/**
 * 全量重写事件文件（JSONL，write tmp + rename 原子）。用于旧格式迁移与上限裁剪。
 * @param file - 目标文件路径。
 * @param events - 事件列表（调用方已裁剪上限）。
 */
export function saveEvents(file: string, events: readonly ObsEvent[]): void {
  mkdirSync(dirOf(file), { recursive: true })
  const tmp = `${file}.tmp`
  const body = events.map(serializeEvent).join('\n')
  writeFileSync(tmp, body.length > 0 ? body + '\n' : body, 'utf8')
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