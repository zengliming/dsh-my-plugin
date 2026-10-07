import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createObservability, FLUSH_BATCH_SIZE, FLUSH_INTERVAL_MS } from './index.ts'
import { aggregateEvents, pluginStatsOf, foldEvent, emptyKindStats } from './types.ts'
import type { ObsEvent } from './types.ts'
import { appendBounded, MAX_EVENTS } from './persist.ts'

/** 构造一条测试事件。 */
function ev(plugin: string, kind: string, ok: boolean, tokens = 100): ObsEvent {
  return { plugin, kind, ok, ts: 1000, tokensSaved: tokens, charsSaved: tokens * 4 }
}

/** 读取磁盘事件文件（JSONL 每行一条，跳过空行/坏行）。 */
function readDiskEvents(file: string): ObsEvent[] {
  const raw = readFileSync(file, 'utf8')
  const events: ObsEvent[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed) as ObsEvent)
    } catch {
      // 坏行跳过，与容错读语义一致
    }
  }
  return events
}

describe('aggregateEvents / pluginStatsOf', () => {
  it('aggregates by plugin then kind', () => {
    const events = [
      ev('@dsh-my-plugin/context-guardian', 'prune', true, 500),
      ev('@dsh-my-plugin/context-guardian', 'prune', false, 0),
      ev('@dsh-my-plugin/context-guardian', 'compact', true, 3000),
      ev('@dsh-my-plugin/hello-world', 'tool-call', true, 0),
    ]
    const stats = pluginStatsOf(aggregateEvents(events))
    const guardian = stats.find((s) => s.plugin === '@dsh-my-plugin/context-guardian')!
    expect(guardian.byKind.prune).toMatchObject({ count: 2, success: 1, failure: 1, tokensSaved: 500 })
    expect(guardian.byKind.compact).toMatchObject({ count: 1, success: 1, tokensSaved: 3000 })
    expect(guardian.total).toMatchObject({ count: 3, tokensSaved: 3500 })
  })

  it('sorts by total count descending', () => {
    const events = [
      ev('a', 'x', true),
      ev('b', 'x', true),
      ev('b', 'y', true),
    ]
    const stats = pluginStatsOf(aggregateEvents(events))
    expect(stats[0]!.plugin).toBe('b')
    expect(stats[1]!.plugin).toBe('a')
  })
})

describe('foldEvent', () => {
  it('accumulates counts and savings (immutable: returns new object)', () => {
    const first = foldEvent(emptyKindStats(), ev('p', 'prune', true, 200))
    expect(first).toMatchObject({ count: 1, success: 1, failure: 0, tokensSaved: 200, charsSaved: 800 })
    const second = foldEvent(first, ev('p', 'prune', false))
    expect(second).toMatchObject({ count: 2, success: 1, failure: 1 })
    // 原对象不被修改（不可变）
    expect(first).toMatchObject({ count: 1, success: 1 })
  })
})

describe('createObservability', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'obs-test-'))
    file = join(dir, 'events.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('records and persists events, loading them back on a new instance', () => {
    const obs1 = createObservability({ plugin: '@dsh-my-plugin/obs', file })
    expect(obs1.record({ kind: 'prune', ok: true, tokensSaved: 1200, charsSaved: 4800 })).toBe(true)
    expect(obs1.record({ kind: 'compact', ok: false })).toBe(true)

    // 落盘是节流式的，断言磁盘内容前先强制 flush
    obs1.flush()
    expect(existsSync(file)).toBe(true)
    expect(readDiskEvents(file)).toHaveLength(2)

    // 新实例（模拟重启）加载历史
    const obs2 = createObservability({ plugin: '@dsh-my-plugin/obs', file })
    const stats = obs2.stats()
    const mine = stats.find((s) => s.plugin === '@dsh-my-plugin/obs')!
    expect(mine.total.count).toBe(2)
    expect(mine.total.tokensSaved).toBe(1200)
    expect(mine.total.failure).toBe(1)
  })

  it('stats() includes persisted history even before new records', () => {
    const obs1 = createObservability({ plugin: '@dsh-my-plugin/obs', file })
    obs1.record({ kind: 'prune', ok: true, tokensSaved: 500 })
    // 必须先落盘，新实例（模拟重启）才能读到历史
    obs1.flush()
    const obs2 = createObservability({ plugin: '@dsh-my-plugin/obs', file })
    const total = obs2.stats()[0]!.total
    expect(total.tokensSaved).toBe(500)
  })

  it('defers disk writes until flush() when neither threshold is hit', () => {
    // 固定时钟 0：间隔永远不触发（lastFlushAt 初始 0，elapsed 恒为 0），批量阈值未达标也不落盘
    const obs = createObservability({ plugin: '@dsh-my-plugin/obs', file, now: () => 0 })
    expect(obs.record({ kind: 'prune', ok: true, tokensSaved: 300 })).toBe(true)

    // 批量延迟：record 后文件尚不存在
    expect(existsSync(file)).toBe(false)
    // 未落盘也不影响内存查询语义（all/stats 基于内存权威列表）
    expect(obs.all()).toHaveLength(1)
    expect(obs.stats()[0]!.total.tokensSaved).toBe(300)

    // flush() 强制写盘
    obs.flush()
    expect(existsSync(file)).toBe(true)
    const fromDisk = readDiskEvents(file)
    expect(fromDisk).toHaveLength(1)
    expect(fromDisk[0]!.tokensSaved).toBe(300)
  })

  it('flushes automatically once the pending batch reaches FLUSH_BATCH_SIZE', () => {
    const obs = createObservability({ plugin: '@dsh-my-plugin/obs', file, now: () => 0 })
    // 前 FLUSH_BATCH_SIZE - 1 条：批量阈值未达标、间隔不触发（固定时钟 0），文件不存在
    for (let i = 0; i < FLUSH_BATCH_SIZE - 1; i++) {
      expect(obs.record({ kind: 'tool-call', ok: true })).toBe(true)
      expect(existsSync(file)).toBe(false)
    }
    // 第 FLUSH_BATCH_SIZE 条触发批量落盘
    expect(obs.record({ kind: 'tool-call', ok: true })).toBe(true)
    expect(existsSync(file)).toBe(true)
    expect(readDiskEvents(file)).toHaveLength(FLUSH_BATCH_SIZE)
  })

  it('flushes automatically once the interval has elapsed', () => {
    let t = 0
    const obs = createObservability({ plugin: '@dsh-my-plugin/obs', file, now: () => t })
    obs.record({ kind: 'prune', ok: true })
    expect(existsSync(file)).toBe(false)
    // 时钟前进超过 FLUSH_INTERVAL_MS，下一条 record 触发间隔落盘
    t = FLUSH_INTERVAL_MS + 500
    obs.record({ kind: 'compact', ok: true })
    expect(existsSync(file)).toBe(true)
    const fromDisk = readDiskEvents(file)
    expect(fromDisk).toHaveLength(2)
    expect(fromDisk[0]!.kind).toBe('prune')
    expect(fromDisk[1]!.kind).toBe('compact')
  })

  it('flush() is idempotent and never throws', () => {
    const obs = createObservability({ plugin: '@dsh-my-plugin/obs', file, now: () => 0 })
    obs.record({ kind: 'prune', ok: true })
    obs.flush()
    expect(existsSync(file)).toBe(true)
    // 连续再次调用不抛错、内容不重复（追加写，无积压即短路）
    expect(() => obs.flush()).not.toThrow()
    expect(() => obs.flush()).not.toThrow()
    expect(readDiskEvents(file)).toHaveLength(1)
  })

  it('multiple instances writing the same file do not overwrite each other', () => {
    // 回归：旧版 {version, events} 全量快照重写时，B 的快照不含 A 的事件会覆盖丢失
    const obsA = createObservability({ plugin: 'plugin-a', file, now: () => 0 })
    const obsB = createObservability({ plugin: 'plugin-b', file, now: () => 0 })
    obsA.record({ kind: 'prune', ok: true, tokensSaved: 100 })
    obsA.flush()
    obsB.record({ kind: 'compact', ok: true, tokensSaved: 200 })
    obsB.flush()
    // 两个实例的事件都在磁盘上
    expect(readDiskEvents(file)).toHaveLength(2)
    // 新实例（模拟重启）能同时读到两个插件的事件
    const fresh = createObservability({ plugin: 'reader', file, now: () => 0 })
    expect(fresh.stats()).toHaveLength(2)
    expect(fresh.stats().reduce((n, s) => n + s.total.count, 0)).toBe(2)
  })

  it('migrates a legacy {version, events} store to JSONL at creation', () => {
    // 旧格式存量文件
    writeFileSync(file, JSON.stringify({ version: 1, events: [ev('old', 'prune', true, 42)] }), 'utf8')
    const obs = createObservability({ plugin: 'new', file, now: () => 0 })
    expect(obs.all()).toHaveLength(1) // 旧事件被容错读加载
    // 创建期已迁移：文件现在是 JSONL
    const migrated = readDiskEvents(file)
    expect(migrated).toHaveLength(1)
    expect(migrated[0]!.plugin).toBe('old')
    // 后续追加保持 JSONL，旧 + 新共两行
    obs.record({ kind: 'compact', ok: true })
    obs.flush()
    const fromDisk = readDiskEvents(file)
    expect(fromDisk).toHaveLength(2)
    expect(fromDisk[0]!.plugin).toBe('old')
    expect(fromDisk[1]!.plugin).toBe('new')
    // 迁移后新实例仍能完整加载
    expect(createObservability({ plugin: 'reader', file, now: () => 0 }).all()).toHaveLength(2)
  })

  it('skips malformed lines when loading JSONL', () => {
    writeFileSync(file, [
      JSON.stringify(ev('a', 'prune', true, 7)),
      'not-json',
      '{"broken":',
      '',
      JSON.stringify(ev('b', 'compact', false)),
    ].join('\n'), 'utf8')
    const obs = createObservability({ plugin: 'p', file })
    expect(obs.all()).toHaveLength(2)
  })

  it('tolerates a corrupt file and falls back to empty', () => {
    const corrupt = join(dir, 'bad.json')
    writeFileSync(corrupt, '{not json', 'utf8')
    const obs = createObservability({ plugin: 'p', file: corrupt })
    expect(obs.all()).toEqual([])
    expect(obs.record({ kind: 'prune', ok: true })).toBe(true)
    expect(obs.all()).toHaveLength(1)
  })

  it('compacts the file to MAX_EVENTS once the cap is reached', () => {
    const obs = createObservability({ plugin: 'p', file, now: () => 0 })
    for (let i = 0; i < MAX_EVENTS + 100; i++) obs.record({ kind: 'tool-call', ok: true })
    obs.flush()
    // 磁盘行数受上限约束（超出即裁剪保留最近 MAX_EVENTS 条）
    expect(readDiskEvents(file).length).toBeLessThanOrEqual(MAX_EVENTS)
    // 内存权威列表同样按上限裁剪
    expect(obs.all()).toHaveLength(MAX_EVENTS)
  })

  it('writes do not throw when the directory is unwritable (graceful)', () => {
    const obs = createObservability({ plugin: 'p', file: join(dir, 'no-such-dir', 'x.json') })
    // 目录父级不存在会 mkdir 递归创建，这里应成功；构造一个确定失败的路径
    const obs2 = createObservability({ plugin: 'p', file: join(dir, 'file-as-dir', 'x.json') })
    writeFileSync(join(dir, 'file-as-dir'), 'i am a file', 'utf8')
    // 不会抛错
    expect(obs2.record({ kind: 'prune', ok: true })).toBe(true)
    expect(obs.record({ kind: 'compact', ok: true })).toBe(true)
    // flush() 在写盘失败时同样不抛错（静默退避重试）
    expect(() => obs.flush()).not.toThrow()
    expect(() => obs2.flush()).not.toThrow()
  })

  it('summarize logs a one-line summary', () => {
    const obs = createObservability({ plugin: '@dsh-my-plugin/obs', file })
    obs.record({ kind: 'prune', ok: true, tokensSaved: 900 })
    const calls: string[] = []
    const logger = {
      info: (msg: string) => calls.push(msg),
      debug: () => {},
      warn: () => {},
      error: () => {},
    } as never
    obs.summarize(logger)
    expect(calls[0]).toContain('saved ~900 tokens')
  })
})

describe('appendBounded', () => {
  it('drops the oldest events beyond the cap', () => {
    const base = Array.from({ length: MAX_EVENTS }, (_, i) => ev('p', 'prune', true, i))
    const next = appendBounded(base, ev('p', 'prune', true, 9999))
    expect(next).toHaveLength(MAX_EVENTS)
    expect(next[next.length - 1]!.tokensSaved).toBe(9999)
    // 最旧的被丢弃
    expect(next[0]!.tokensSaved).toBe(1)
  })
})
