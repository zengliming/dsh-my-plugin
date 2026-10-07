import { describe, expect, it } from 'vitest'
import { pruneStaleGuards, effectiveRetryCount, isStaleRetryEntry, overflowRetryAllowed } from './guard-state.ts'

describe('pruneStaleGuards', () => {
  it('removes idle entries older than staleMs', () => {
    const now = 10_000_000
    const guards = new Map<string, { lastInspectAt: number; inFlight: boolean }>([
      ['old-idle', { lastInspectAt: now - 31 * 60_000, inFlight: false }],
      ['recent-idle', { lastInspectAt: now, inFlight: false }],
    ])
    const removed = pruneStaleGuards(guards, now, 30 * 60_000)
    expect(removed).toBe(1)
    expect(guards.has('old-idle')).toBe(false)
    expect(guards.has('recent-idle')).toBe(true)
  })

  it('keeps in-flight entries regardless of age', () => {
    const now = 10_000_000
    const guards = new Map<string, { lastInspectAt: number; inFlight: boolean }>([
      ['old-inflight', { lastInspectAt: 0, inFlight: true }],
    ])
    expect(pruneStaleGuards(guards, now, 30 * 60_000)).toBe(0)
    expect(guards.has('old-inflight')).toBe(true)
  })

  it('returns 0 and keeps everything when nothing is stale', () => {
    const now = 10_000_000
    const guards = new Map<string, { lastInspectAt: number; inFlight: boolean }>([
      ['a', { lastInspectAt: now - 1, inFlight: false }],
      ['b', { lastInspectAt: now, inFlight: false }],
    ])
    expect(pruneStaleGuards(guards, now, 30 * 60_000)).toBe(0)
    expect(guards.size).toBe(2)
  })
})

describe('effectiveRetryCount / isStaleRetryEntry', () => {
  const windowMs = 120_000
  const now = 1_000_000

  it('counts entries only inside the window', () => {
    expect(effectiveRetryCount({ count: 3, at: now - 10_000 }, now, windowMs)).toBe(3)
    expect(effectiveRetryCount({ count: 3, at: now - 200_000 }, now, windowMs)).toBe(0)
    expect(effectiveRetryCount(undefined, now, windowMs)).toBe(0)
  })

  it('flags stale entries exactly at the window boundary', () => {
    expect(isStaleRetryEntry({ count: 1, at: now - windowMs }, now, windowMs)).toBe(true)
    expect(isStaleRetryEntry({ count: 1, at: now - windowMs + 1 }, now, windowMs)).toBe(false)
    expect(isStaleRetryEntry(undefined, now, windowMs)).toBe(false)
  })
})

describe('overflowRetryAllowed', () => {
  const windowMs = 120_000
  const now = 1_000_000

  it('allows retries below the limit', () => {
    expect(overflowRetryAllowed(undefined, now, 2, windowMs)).toBe(true)
    expect(overflowRetryAllowed({ count: 1, at: now }, now, 2, windowMs)).toBe(true)
  })

  it('blocks retries at the limit', () => {
    expect(overflowRetryAllowed({ count: 2, at: now }, now, 2, windowMs)).toBe(false)
    expect(overflowRetryAllowed({ count: 5, at: now }, now, 2, windowMs)).toBe(false)
  })

  it('zero limit blocks even the first retry (0-case semantics)', () => {
    expect(overflowRetryAllowed(undefined, now, 0, windowMs)).toBe(false)
    expect(overflowRetryAllowed({ count: 0, at: now }, now, 0, windowMs)).toBe(false)
  })

  it('treats out-of-window entries as a fresh start', () => {
    const stale = { count: 9, at: now - 10 * windowMs }
    expect(overflowRetryAllowed(stale, now, 2, windowMs)).toBe(true)
  })
})
