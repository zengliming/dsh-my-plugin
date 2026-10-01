import { describe, expect, it } from 'vitest'
import { composeGreeting } from './index.ts'

describe('composeGreeting', () => {
  it('replaces the name placeholder', () => {
    expect(composeGreeting('Hello, {name}!', 'Alice', false)).toBe('Hello, Alice!')
  })

  it('falls back to the raw template when no placeholder is present', () => {
    expect(composeGreeting('Hi there', 'Alice', false)).toBe('Hi there')
  })

  it('uppercases the whole greeting when enabled', () => {
    expect(composeGreeting('Hello, {name}!', 'Bob', true)).toBe('HELLO, BOB!')
  })

  it('treats an empty name as the caller-provided empty string (apply trims/falls back)', () => {
    expect(composeGreeting('Hello, {name}!', '', false)).toBe('Hello, !')
  })
})
