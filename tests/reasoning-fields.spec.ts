import { describe, expect, it } from 'vitest'
import { declaredFixedEffort, reasoningFields } from '../src/adapter.ts'
import type { WorkBuddyUpstreamModel } from '../src/upstream.ts'

function row(reasoning: WorkBuddyUpstreamModel['reasoning']): WorkBuddyUpstreamModel {
  return {
    id: 'deepseek-v4.1-flash',
    name: 'Deepseek-V4.1-Flash',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImages: true,
    ...reasoning === undefined ? {} : { reasoning },
    billing: { credits: 'x0.00', free: true },
  }
}

// The upstream ships two shapes of reasoning declaration. The second one used to
// be reported as "no reasoning", which kept `reasoning_effort` off the wire —
// upstream then builds no `reasoning_content` channel and the model's
// `<analysis>` scaffolding spilled into the visible answer.
describe('reasoningFields', () => {
  it('offers exactly the declared effort set', () => {
    const fields = reasoningFields(row({
      supports: true,
      onlyReasoning: false,
      supportedEfforts: ['low', 'high'],
      defaultEffort: 'high',
      canDisableThinking: true,
    }))
    expect(fields.reasoning).toBe(true)
    expect(fields.thinkingLevelMap).toMatchObject({ off: 'off', low: 'low', high: 'high', medium: null, max: null })
  })

  it('treats a lone fixed effort as the model\'s one level', () => {
    const info = row({
      supports: true,
      onlyReasoning: true,
      defaultEffort: 'high',
      canDisableThinking: false,
    })
    expect(declaredFixedEffort(info)).toBe('high')
    const fields = reasoningFields(info)
    expect(fields.reasoning).toBe(true)
    expect(fields.thinkingLevelMap).toMatchObject({ high: 'high', low: null, off: null })
  })

  // The live catalog ships this exact shape for `deepseek-v4.1-flash`: a declared
  // effort set together with both `onlyReasoning: true` and `canDisableThinking: true`.
  // Trusting the second flag put a string `off` in the map, and any request that
  // selected no level then carried `reasoning_effort: "off"` — a value the provider
  // rejects. Compaction never selects a level, so it failed on every attempt.
  it('keeps off the wire when a declared set also claims thinking is switchable', () => {
    const fields = reasoningFields(row({
      supports: true,
      onlyReasoning: true,
      supportedEfforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
      canDisableThinking: true,
    }))
    expect(fields.reasoning).toBe(true)
    expect(fields.thinkingLevelMap).toMatchObject({ off: null, low: 'low', high: 'high', max: 'max' })
  })

  it('still offers nothing when no effort is declared at all', () => {
    const info = row({ supports: true, onlyReasoning: false, canDisableThinking: false })
    expect(declaredFixedEffort(info)).toBeUndefined()
    expect(reasoningFields(info)).toEqual({ reasoning: false })
  })

  it('never invents control for a non-reasoning model', () => {
    expect(reasoningFields(row(undefined))).toEqual({ reasoning: false })
    expect(reasoningFields(row({ supports: false, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false })))
      .toEqual({ reasoning: false })
  })
})
