import { describe, expect, it } from 'vitest'
import { trimText, extractText, pollutionReplacement, makeReplacementMessage, PRUNE_MARKER, POLLUTION_MARKER } from './execute.ts'
import type { SurfaceNodeView } from './types.ts'

describe('trimText', () => {
  it('returns text unchanged when within limit', () => {
    expect(trimText('short', 100)).toBe('short')
  })

  it('trims oversized text keeping head and tail with a marker', () => {
    const text = 'A'.repeat(3000)
    const trimmed = trimText(text, 1000)
    expect(trimmed).toContain(PRUNE_MARKER)
    expect(trimmed).toContain('[2600 chars trimmed]')
    // 保留比例 0.2 + 0.2 = 40% 预算，即 400 字符 + 标记
    expect(trimmed.length).toBeLessThan(600)
    // 头尾内容保留
    expect(trimmed.startsWith(PRUNE_MARKER)).toBe(true)
    expect(trimmed.endsWith('A')).toBe(true)
  })

  it('never grows the text', () => {
    const text = 'B'.repeat(500)
    const trimmed = trimText(text, 100)
    expect(trimmed.length).toBeLessThan(500)
  })
})

describe('extractText', () => {
  it('concatenates text blocks and skips others', () => {
    expect(extractText([
      { type: 'text', text: 'hello ' },
      { type: 'reasoning', text: 'skip' },
      { type: 'image', attachment: { attachmentId: 'a' as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
      { type: 'text', text: 'world' },
    ])).toBe('hello world')
  })
})

describe('pollutionReplacement', () => {
  it('produces a placeholder mentioning the suppressed role', () => {
    const node: SurfaceNodeView = { seq: 1, role: 'tool', text: 'x', tokens: 5, isError: true, toolName: 'run_code' }
    const text = pollutionReplacement(node)
    expect(text).toContain(POLLUTION_MARKER)
    expect(text).toContain('tool=run_code')
    expect(text).toContain('repeated failure')
  })
})

describe('makeReplacementMessage', () => {
  it('creates a valid user message with an id', () => {
    const message = makeReplacementMessage('summary text')
    expect(message.role).toBe('user')
    expect(message.source.kind).toBe('user')
    expect(message.content[0]?.type).toBe('text')
    // createUserMessage 会分配稳定 id
    expect(typeof message.id).toBe('string')
  })
})