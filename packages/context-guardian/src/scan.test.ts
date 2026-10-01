import { describe, expect, it } from 'vitest'
import { scanSurface, pickBestRange, matchesProtectedKeyword, isNoisyText } from './scan.ts'
import type { SurfaceNodeView } from './types.ts'

/** 构造一个工具结果节点视图的辅助函数。 */
function tool(seq: number, text: string, tokens: number, opts: { isError?: boolean } = {}): SurfaceNodeView {
  return { seq, role: 'tool', text, tokens, isError: opts.isError }
}

function user(seq: number, text: string, tokens: number): SurfaceNodeView {
  return { seq, role: 'user', text, tokens }
}

function assistant(seq: number, text: string, tokens: number): SurfaceNodeView {
  return { seq, role: 'assistant', text, tokens }
}

const BASE = {
  toolResultCharLimit: 4000,
  protectRecentMessages: 0,
  protectKeywords: ['密码', 'token'],
  pruneToolResults: true,
  pollutionCleanup: true,
}

describe('matchesProtectedKeyword', () => {
  it('matches substring case-insensitively', () => {
    expect(matchesProtectedKeyword('API Token 是 xxx', ['token'])).toBe(true)
    expect(matchesProtectedKeyword('普通文本', ['token'])).toBe(false)
  })

  it('ignores empty keyword list and empty keywords', () => {
    expect(matchesProtectedKeyword('anything', [])).toBe(false)
    expect(matchesProtectedKeyword('anything', [''])).toBe(false)
  })
})

describe('isNoisyText', () => {
  it('flags repeated lines as noisy', () => {
    const noisy = Array.from({ length: 10 }, () => 'this is a long repeated line with enough length').join('\n')
    expect(isNoisyText(noisy)).toBe(true)
  })

  it('keeps short and diverse text clean', () => {
    expect(isNoisyText('short')).toBe(false)
    const diverse = ['a=1', 'b=2', 'c=3', 'd=4', 'e=5', 'f=6'].join('\n')
    expect(isNoisyText(diverse)).toBe(false)
  })
})

describe('scanSurface', () => {
  it('protects the most recent messages', () => {
    // 长文本用户消息避免命中"短指令保护"，只验证最近 N 条规则。
    const nodes = [
      user(1, 'u1' + 'x'.repeat(800), 10),
      assistant(2, 'a1', 20),
      user(3, 'u2' + 'x'.repeat(800), 10),
      tool(4, 't1', 30),
    ]
    const scan = scanSurface(nodes, { ...BASE, protectRecentMessages: 2 })
    // 最近 2 条（seq 3,4）受保护
    expect(scan.protectedSeqs).toContain(3)
    expect(scan.protectedSeqs).toContain(4)
    // 较早消息不受保护
    expect(scan.protectedSeqs).not.toContain(1)
    expect(scan.protectedSeqs).not.toContain(2)
  })

  it('protects short user instructions', () => {
    const nodes = [user(1, '请把文件读出来', 50), assistant(2, 'long reply…'.repeat(200), 800)]
    const scan = scanSurface(nodes, BASE)
    expect(scan.protectedSeqs).toContain(1)
  })

  it('protects keyword-matched nodes', () => {
    const nodes = [tool(1, '密码是 abc123', 30), tool(2, '普通输出', 10)]
    const scan = scanSurface(nodes, BASE)
    expect(scan.protectedSeqs).toContain(1)
    expect(scan.protectedSeqs).not.toContain(2)
  })

  it('marks oversized tool results as prunable but not protected', () => {
    const nodes = [tool(1, 'x'.repeat(5000), 100)]
    const scan = scanSurface(nodes, { ...BASE, toolResultCharLimit: 1000 })
    expect(scan.prunableSeqs).toContain(1)
    expect(scan.protectedSeqs).not.toContain(1)
  })

  it('flags repeated failure streaks as pollution, keeping the latest', () => {
    const nodes = [
      tool(1, 'err a', 5, { isError: true }),
      tool(2, 'err b', 5, { isError: true }),
      tool(3, 'err c', 5, { isError: true }),
    ]
    const scan = scanSurface(nodes, BASE)
    expect(scan.pollutionSeqs).toContain(3)
    expect(scan.pollutionSeqs).not.toContain(1)
  })

  it('computes compressible ranges between protected nodes', () => {
    const nodes = [
      user(1, '目标', 10),                 // 保护（短指令）
      assistant(2, 'a1', 100),             // 可压缩
      tool(3, 't1', 200),                  // 可压缩
      assistant(4, 'a2', 50),              // 可压缩
      user(5, '最近的用户消息', 10),        // 保护（最近消息）
    ]
    const scan = scanSurface(nodes, { ...BASE, protectRecentMessages: 1 })
    expect(scan.compressibleRanges).toEqual([{ start: 2, end: 4, savingsTokens: 350 }])
  })

  it('does not form ranges from a single unprotected node', () => {
    const nodes = [
      user(1, '目标', 10),
      tool(2, 't1', 200),
      user(3, '最新', 10),
    ]
    const scan = scanSurface(nodes, { ...BASE, protectRecentMessages: 1 })
    expect(scan.compressibleRanges).toEqual([])
  })
})

describe('pickBestRange', () => {
  it('picks the largest saving above the minimum', () => {
    const ranges = [
      { start: 2, end: 3, savingsTokens: 15_000 },
      { start: 4, end: 6, savingsTokens: 50_000 },
      { start: 8, end: 9, savingsTokens: 12_000 },
    ]
    expect(pickBestRange(ranges, 20_000)).toEqual({ start: 4, end: 6, savingsTokens: 50_000 })
  })

  it('returns undefined when nothing meets the minimum', () => {
    const ranges = [{ start: 1, end: 2, savingsTokens: 5_000 }]
    expect(pickBestRange(ranges, 20_000)).toBeUndefined()
  })

  it('prefers the smaller range on equal savings', () => {
    const ranges = [
      { start: 1, end: 5, savingsTokens: 30_000 },
      { start: 2, end: 3, savingsTokens: 30_000 },
    ]
    expect(pickBestRange(ranges, 10_000)).toEqual({ start: 2, end: 3, savingsTokens: 30_000 })
  })
})