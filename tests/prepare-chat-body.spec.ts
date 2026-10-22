import { describe, expect, it } from 'vitest'
import { prepareChatBody } from '../src/upstream.ts'

const banner = 'You are an AI agent powered by DeepSeek Harness.'

function firstSystem(source: string): unknown {
  const body = JSON.parse(prepareChatBody(source)) as {
    messages: { role: string, content: unknown }[]
  }
  return body.messages[0]?.content
}

function body(content: unknown, role = 'system'): string {
  return JSON.stringify({ model: 'm', messages: [{ role, content }, { role: 'user', content: 'hi' }] })
}

describe('prepareChatBody harness banner', () => {
  it('renames the brand word the domestic gateway fingerprints', () => {
    expect(firstSystem(body(banner + '\n\n# Rules\nkeep me')))
      .toBe('You are an AI agent powered by DSH.\n\n# Rules\nkeep me')
  })

  it('rewrites a text part inside a content array', () => {
    expect(firstSystem(body([{ type: 'text', text: banner }])))
      .toEqual([{ type: 'text', text: 'You are an AI agent powered by DSH.' }])
  })

  it('leaves a banner that is not at the sentence start alone', () => {
    const trailing = `system preamble\n\n${banner}`
    expect(firstSystem(body(trailing))).toBe(trailing)
  })

  it('leaves a non-system first message alone', () => {
    const source = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: banner }] })
    const prepared = JSON.parse(prepareChatBody(source)) as {
      messages: { role: string, content: unknown }[]
    }
    expect(prepared.messages[1]?.content).toBe(banner)
  })
})
