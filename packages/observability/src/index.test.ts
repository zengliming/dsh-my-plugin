import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createObservability } from './index.ts'
import { aggregateEvents, pluginStatsOf, foldEvent, emptyKindStats } from './types.ts'
import type { ObsEvent } from './types.ts'
import { appendBounded, MAX_EVENTS } from './persist.ts'

/** 构造一条测试事件。 */
function ev(plugin: string, kind: string, ok: boolean, tokens = 100): ObsEvent {
  return { plugin, kind, ok, ts: 1000, tokensSaved: tokens, charsSaved: tokens * 4 }
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

    // 持久化落盘
    expect(existsSync(file)).toBe(true)
    const fromDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(fromDisk.events).toHaveLength(2)

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
    const obs2 = createObservability({ plugin: '@dsh-my-plugin/obs', file })
    const total = obs2.stats()[0]!.total
    expect(total.tokensSaved).toBe(500)
  })

  it('tolerates a corrupt file and falls back to empty', () => {
    const corrupt = join(dir, 'bad.json')
    require('node:fs').writeFileSync(corrupt, '{not json')
    const obs = createObservability({ plugin: 'p', file: corrupt })
    expect(obs.all()).toEqual([])
    expect(obs.record({ kind: 'prune', ok: true })).toBe(true)
    expect(obs.all()).toHaveLength(1)
  })

  it('writes do not throw when the directory is unwritable (graceful)', () => {
    const obs = createObservability({ plugin: 'p', file: join(dir, 'no-such-dir', 'x.json') })
    // 目录父级不存在会 mkdir 递归创建，这里应成功；构造一个确定失败的路径
    const obs2 = createObservability({ plugin: 'p', file: join(dir, 'file-as-dir', 'x.json') })
    require('node:fs').writeFileSync(join(dir, 'file-as-dir'), 'i am a file')
    // 不会抛错
    expect(obs2.record({ kind: 'prune', ok: true })).toBe(true)
    expect(obs.record({ kind: 'compact', ok: true })).toBe(true)
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