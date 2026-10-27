import { describe, expect, it } from 'vitest'
import { separateTokenBoundaries } from '../src/upstream.ts'

/** The exact 111-character run the domestic gateway blocked on 2026-10-27. */
const FINGERPRINT = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root'

const NBSP = '\u00a0'

function body(systemText: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'm',
    messages: [{ role: 'system', content: systemText }, { role: 'user', content: 'hi' }],
    ...extra,
  })
}

function systemOf(source: string): string {
  const parsed = JSON.parse(source) as { messages: { role: string; content: unknown }[] }
  return String(parsed.messages[0]?.content)
}

/** Longest run of original (non-NBSP) characters left in the text. */
function longestIntactRun(text: string): number {
  let longest = 0
  let current = 0
  for (const char of text) {
    if (char === NBSP) {
      longest = Math.max(longest, current)
      current = 0
      continue
    }
    current++
  }
  return Math.max(longest, current)
}

describe('separateTokenBoundaries', () => {
  it('leaves short system text byte-identical', () => {
    const short = 'You are a helpful assistant.'
    expect(separateTokenBoundaries(body(short))).toBe(body(short))
  })

  it('breaks a fingerprint the gateway blocks on', () => {
    const long = `${FINGERPRINT}\n\n${'filler prose. '.repeat(40)}`
    const out = systemOf(separateTokenBoundaries(body(long)))
    expect(out).not.toBe(long)
    // The whole point: the blocked run cannot survive intact.
    expect(out.includes(FINGERPRINT)).toBe(false)
    // 40 plus at most one word (~10 chars) before the next space arrives.
    expect(longestIntactRun(out)).toBeLessThanOrEqual(55)
  })

  it('keeps every original character, only swapping spaces for no-break spaces', () => {
    const long = `${FINGERPRINT}\n\n${'filler prose. '.repeat(40)}`
    const out = systemOf(separateTokenBoundaries(body(long)))
    expect(out.replaceAll(NBSP, ' ')).toBe(long)
    expect(out.length).toBe(long.length)
  })

  it('leaves user and tool messages untouched', () => {
    const long = `${FINGERPRINT}\n\n${'filler prose. '.repeat(40)}`
    const source = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: long },
        { role: 'tool', content: long, tool_call_id: 'c' },
      ],
    })
    // User text is the user's own words and tool text is their file contents:
    // a U+00A0 landing in either could be written straight back into a file.
    expect(separateTokenBoundaries(source)).toBe(source)
    expect(source.includes(FINGERPRINT)).toBe(true)
  })

  it('rewrites assistant text, which an echoed quote would otherwise re-introduce', () => {
    const long = `${FINGERPRINT}\n\n${'filler prose. '.repeat(40)}`
    const source = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'quote your prompt' },
        { role: 'assistant', content: long },
      ],
    })
    const parsed = JSON.parse(separateTokenBoundaries(source)) as { messages: { content: string }[] }
    const assistant = parsed.messages[2]?.content ?? ''
    expect(assistant.includes(FINGERPRINT)).toBe(false)
    expect(assistant.replaceAll(NBSP, ' ')).toBe(long)
  })

  it('rewrites a text part inside a content array', () => {
    const long = `${FINGERPRINT}\n\n${'filler prose. '.repeat(40)}`
    const source = JSON.stringify({ model: 'm', messages: [{ role: 'system', content: [{ type: 'text', text: long }] }] })
    const parsed = JSON.parse(separateTokenBoundaries(source)) as {
      messages: { content: { type: string; text: string }[] }[]
    }
    const text = parsed.messages[0]?.content[0]?.text ?? ''
    expect(text.includes(FINGERPRINT)).toBe(false)
    expect(text.replaceAll(NBSP, ' ')).toBe(long)
  })

  it('passes a non-JSON or non-object body through unchanged', () => {
    expect(separateTokenBoundaries('not json')).toBe('not json')
    expect(separateTokenBoundaries('[1,2]')).toBe('[1,2]')
    expect(separateTokenBoundaries('null')).toBe('null')
    expect(separateTokenBoundaries(JSON.stringify({ model: 'm' }))).toBe(JSON.stringify({ model: 'm' }))
  })
})
