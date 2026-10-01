import { describe, expect, it, vi } from 'vitest'
import { inspectAgent } from './orchestrator.ts'
import type { Platform } from './orchestrator.ts'
import { resolveConfig } from './config.ts'
import type { SurfaceNodeView } from './types.ts'

/**
 * 构造一个最小 agent 桩：session 带 append 记录器（execute.ts 的替换需要 append，
 * 这里只验证调用编排，不校验 Session 内部协议），options 提供路由。
 */
function fakeAgent(sessionId: string) {
  const appended: { type: string; data: unknown; opts: unknown }[] = []
  return {
    agent: {
      id: sessionId,
      session: {
        id: sessionId,
        append: (type: string, data: unknown, opts?: unknown) => {
          appended.push({ type, data, opts })
          return { seq: 999, time: 0, data }
        },
      },
      options: { provider: 'test', model: 'test-model' },
    } as never,
    appended,
  }
}

/** 构造最小 Platform 桩。 */
function fakePlatform(overrides: Partial<Platform> = {}): Platform {
  return {
    measure: () => ({ totalTokens: 0, surfaceTokens: 0 }),
    project: () => [],
    compactRegion: vi.fn(async () => undefined),
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      // Logger 接口其余字段（LoggerOptions）用最小桩
    } as never,
    ...overrides,
  }
}

/** 构造一组表面节点：用户目标 + 中间过程 + 最近消息。 */
function sampleNodes(): SurfaceNodeView[] {
  return [
    { seq: 1, role: 'user', text: '帮我做一个插件', tokens: 20 },
    { seq: 2, role: 'assistant', text: 'a1'.repeat(200), tokens: 400 },
    { seq: 3, role: 'tool', text: 'x'.repeat(6000), tokens: 1500 },
    { seq: 4, role: 'assistant', text: 'a2'.repeat(200), tokens: 300 },
    { seq: 5, role: 'user', text: '最新消息' + 'x'.repeat(800), tokens: 200 },
  ]
}

describe('inspectAgent', () => {
  it('does nothing below prune threshold', async () => {
    const platform = fakePlatform()
    const { agent } = fakeAgent('s1')
    const summary = await inspectAgent(agent, platform, resolveConfig({ pruneTokens: 200_000 }), new AbortController().signal)
    expect(summary.pruned).toEqual([])
    expect(summary.compacted).toBeUndefined()
    expect(platform.compactRegion).not.toHaveBeenCalled()
  })

  it('prunes oversized tool results at prune level', async () => {
    const platform = fakePlatform({
      measure: () => ({ totalTokens: 170_000, surfaceTokens: 170_000 }),
      project: () => sampleNodes(),
    })
    const { agent } = fakeAgent('s2')
    const summary = await inspectAgent(agent, platform, resolveConfig({
      pruneTokens: 160_000,
      compactTokens: 200_000,
      toolResultCharLimit: 1_000,
    }), new AbortController().signal)
    // seq 3 是唯一超限工具结果（6000 > 1000）
    expect(summary.pruned).toContain(3)
    expect(platform.compactRegion).not.toHaveBeenCalled()
  })

  it('compacts a low-value range at compact level', async () => {
    const platform = fakePlatform({
      measure: () => ({ totalTokens: 210_000, surfaceTokens: 210_000 }),
      project: () => sampleNodes(),
    })
    const { agent } = fakeAgent('s3')
    const summary = await inspectAgent(agent, platform, resolveConfig({
      pruneTokens: 160_000,
      compactTokens: 200_000,
      minSavingsTokens: 1,
      toolResultCharLimit: 10_000, // 不触发剪枝，专注压缩路径
      protectRecentMessages: 1,   // 只保护最新 1 条，暴露 seq 2..4 可压缩区间
    }), new AbortController().signal)
    // 可压缩区间：seq 2..4（用户目标/最近消息被保护）
    expect(summary.compacted).toEqual({ start: 2, end: 4 })
    expect(platform.compactRegion).toHaveBeenCalledWith(2, 4, expect.objectContaining({ session: expect.anything(), options: { provider: 'test', model: 'test-model' } }), expect.anything())
  })

  it('protects keywords from compaction', async () => {
    const platform = fakePlatform({
      measure: () => ({ totalTokens: 210_000, surfaceTokens: 210_000 }),
      project: () => [
        { seq: 1, role: 'user', text: '帮我做一个插件', tokens: 20 },
        { seq: 2, role: 'assistant', text: '关键内容 密码 abc123 在此', tokens: 400 },
        { seq: 3, role: 'tool', text: 'x'.repeat(6000), tokens: 1500 },
        { seq: 4, role: 'user', text: '最新消息' + 'x'.repeat(800), tokens: 200 },
      ],
    })
    const { agent } = fakeAgent('s4')
    const summary = await inspectAgent(agent, platform, resolveConfig({
      pruneTokens: 160_000,
      compactTokens: 200_000,
      minSavingsTokens: 1,
      toolResultCharLimit: 10_000,
      protectKeywords: ['密码'],
      protectRecentMessages: 1,
    }), new AbortController().signal)
    // seq 2 命中关键词被保护 → 无可压缩区间
    expect(summary.compacted).toBeUndefined()
    expect(platform.compactRegion).not.toHaveBeenCalled()
  })

  it('keeps working when measure throws (error isolation)', async () => {
    const platform = fakePlatform({
      measure: () => {
        throw new Error('meter down')
      },
    })
    const { agent } = fakeAgent('s5')
    const summary = await inspectAgent(agent, platform, resolveConfig(), new AbortController().signal)
    expect(summary.totalTokens).toBe(0)
    expect(summary.compacted).toBeUndefined()
    expect(platform.log.warn).toHaveBeenCalled()
  })

  it('keeps working when compactRegion throws (error isolation)', async () => {
    const platform = fakePlatform({
      measure: () => ({ totalTokens: 210_000, surfaceTokens: 210_000 }),
      project: () => sampleNodes(),
      compactRegion: vi.fn(async () => {
        throw new Error('compaction busy')
      }),
    })
    const { agent } = fakeAgent('s6')
    const summary = await inspectAgent(agent, platform, resolveConfig({
      pruneTokens: 160_000,
      compactTokens: 200_000,
      minSavingsTokens: 1,
      toolResultCharLimit: 10_000,
      protectRecentMessages: 1,
    }), new AbortController().signal)
    expect(summary.compacted).toBeUndefined()
    expect(platform.log.warn).toHaveBeenCalled()
  })
})