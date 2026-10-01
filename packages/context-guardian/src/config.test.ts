import { describe, expect, it } from 'vitest'
import { resolveConfig, pressureLevel, shouldCompact, shouldPrune, shouldCleanPollution } from './config.ts'

describe('resolveConfig', () => {
  it('fills defaults when empty', () => {
    const c = resolveConfig()
    expect(c.enabled).toBe(true)
    expect(c.pruneTokens).toBe(160_000)
    expect(c.protectRecentMessages).toBe(8)
  })

  it('respects overrides', () => {
    const c = resolveConfig({ pruneTokens: 1, protectRecentMessages: 0 })
    expect(c.pruneTokens).toBe(1)
    expect(c.protectRecentMessages).toBe(0)
  })
})

describe('pressureLevel', () => {
  const cfg = resolveConfig()

  it('grades calm below watch', () => {
    expect(pressureLevel(0, cfg)).toBe('calm')
    expect(pressureLevel(100, cfg)).toBe('calm')
  })

  it('grades watch / prune / compact / critical at thresholds', () => {
    expect(pressureLevel(cfg.watchTokens, cfg)).toBe('watch')
    expect(pressureLevel(cfg.pruneTokens, cfg)).toBe('prune')
    expect(pressureLevel(cfg.compactTokens, cfg)).toBe('compact')
    expect(pressureLevel(cfg.criticalTokens, cfg)).toBe('critical')
  })

  it('critical wins when thresholds overlap (non-monotonic config)', () => {
    const odd = resolveConfig({ watchTokens: 0, pruneTokens: 0, compactTokens: 0, criticalTokens: 0 })
    expect(pressureLevel(0, odd)).toBe('critical')
  })
})

describe('action gates', () => {
  it('maps level to actions', () => {
    expect(shouldPrune('calm')).toBe(false)
    expect(shouldPrune('watch')).toBe(false)
    expect(shouldPrune('prune')).toBe(true)
    expect(shouldCompact('prune')).toBe(false)
    expect(shouldCompact('compact')).toBe(true)
    expect(shouldCompact('critical')).toBe(true)
    expect(shouldCleanPollution('watch')).toBe(false)
    expect(shouldCleanPollution('prune')).toBe(true)
  })
})