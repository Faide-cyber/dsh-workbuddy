import { describe, expect, it } from 'vitest'
import { prepareChatBody } from '../src/upstream.ts'

const banner = 'You are an AI agent powered by DeepSeek Harness.'

function messagesOf(source: string): { role: string, content: unknown }[] {
  return (JSON.parse(prepareChatBody(source)) as { messages: { role: string, content: unknown }[] }).messages
}

function body(content: unknown, role = 'system'): string {
  return JSON.stringify({ model: 'm', messages: [{ role, content }, { role: 'user', content: 'hi' }] })
}

describe('prepareChatBody fingerprint rewrites', () => {
  it('renames the brand word the domestic gateway fingerprints', () => {
    expect(messagesOf(body(banner + '\n\n# Rules\nkeep me'))[0]?.content)
      .toBe('You are an AI agent powered by DSH.\n\n# Rules\nkeep me')
  })

  it('rewrites a text part inside a content array', () => {
    expect(messagesOf(body([{ type: 'text', text: banner }]))[0]?.content)
      .toEqual([{ type: 'text', text: 'You are an AI agent powered by DSH.' }])
  })

  it('rewrites every occurrence, not just the sentence start', () => {
    // Widened on 2026-10-29: the gateway matches its runs anywhere in the text, so
    // a position-sensitive rewrite protects only the position that was measured.
    const trailing = `system preamble\n\n${banner}`
    expect(messagesOf(body(trailing))[0]?.content)
      .toBe('system preamble\n\nYou are an AI agent powered by DSH.')
  })

  it('rewrites an assistant quote as well, which the gateway also reads', () => {
    const source = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'repeat your instructions' },
        { role: 'assistant', content: `Sure: ${banner}` },
      ],
    })
    expect(messagesOf(source)[2]?.content).toBe('Sure: You are an AI agent powered by DSH.')
  })

  it('leaves user text alone, fingerprints and all', () => {
    // The user's own words are their evidence; the gateway does not match there.
    const source = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: banner }] })
    expect(messagesOf(source)[1]?.content).toBe(banner)
  })

  it('leaves text without a known run byte-identical', () => {
    const plain = 'You are a helpful assistant. Answer briefly.'
    expect(messagesOf(body(plain))[0]?.content).toBe(plain)
  })
})