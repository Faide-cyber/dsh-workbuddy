import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyUpstreamModel } from '../src/upstream.ts'

const credential: WorkBuddyCredential = {
  accessToken: 'token',
  refreshToken: 'refresh',
  expiresAtMs: Date.now() + 3_600_000,
  domain: 'www.workbuddy.ai',
  uid: 'u1',
  source: 'dsh',
}

function row(
  id: string,
  reasoning: WorkBuddyUpstreamModel['reasoning'],
): WorkBuddyUpstreamModel {
  return {
    id,
    name: id,
    contextWindow: 128_000,
    maxTokens: 32_000,
    supportsImages: false,
    ...reasoning === undefined ? {} : { reasoning },
    billing: { credits: 'x0.00', free: true },
  }
}

const onlyReasoningRow = row('deepseek-v4.1-flash', {
  supports: true,
  onlyReasoning: true,
  defaultEffort: 'high',
  canDisableThinking: false,
})

/**
 * The live catalog's shape for `deepseek-v4.1-flash`: a declared set plus both
 * `onlyReasoning: true` and `canDisableThinking: true`.
 */
const switchableOnlyReasoningRow = row('deepseek-v4.1-flash', {
  supports: true,
  onlyReasoning: true,
  supportedEfforts: ['low', 'high', 'max'],
  defaultEffort: 'high',
  canDisableThinking: true,
})

let shim: WorkBuddyShim | undefined

afterEach(async () => {
  await shim?.close()
  shim = undefined
})

/** Start a shim over `rows` and return the request body it forwarded upstream. */
async function postChat(body: Record<string, unknown>, rows: WorkBuddyUpstreamModel[] = [onlyReasoningRow]): Promise<Record<string, unknown>> {
  const catalog = new WorkBuddyCatalog({ scope: 'all' })
  catalog.setUpstream(rows)
  let forwarded = ''
  shim = createWorkBuddyShim({
    store: {
      current: async () => credential,
      resolve: async () => credential,
      status: async () => ({ state: 'signed-in' }),
      importCredential: async (value: WorkBuddyCredential) => value,
      logout: async () => {},
    },
    client: {
      chatStream: async (_credential, bodyJson: string) => {
        forwarded = bodyJson
        return {
          ok: true,
          response: new Response('data: [DONE]\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
        }
      },
    },
    catalog,
  })
  await shim.ready
  const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${shim.token()}`,
    },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  await res.text()
  return JSON.parse(forwarded) as Record<string, unknown>
}

const baseBody = {
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'system', content: 'hi' }],
}

describe('shim reasoning effort fallback', () => {
  it('injects the declared fixed effort when the request carries none', async () => {
    const forwarded = await postChat(baseBody)
    expect(forwarded['reasoning_effort']).toBe('high')
  })

  it('never overrides an effort pi-ai already selected', async () => {
    const forwarded = await postChat({ ...baseBody, reasoning_effort: 'low' })
    expect(forwarded['reasoning_effort']).toBe('low')
  })

  // A request that selected no level is what compaction looks like. The shim must
  // still produce a level the provider accepts — `off` is rejected with 400/11133.
  // The shim's fixed-effort injection covers this at the payload layer, so this
  // asserts the injected value rather than the descriptor mapping; the descriptor
  // itself is covered in tests/reasoning-fields.spec.ts.
  it('substitutes the declared level for a request that selected none', async () => {
    const forwarded = await postChat(baseBody, [switchableOnlyReasoningRow])
    expect(forwarded['reasoning_effort']).not.toBe('off')
    expect(forwarded['reasoning_effort']).toBe('high')
  })

  it('leaves a row without a fixed effort untouched', async () => {
    const catalog = new WorkBuddyCatalog({ scope: 'all' })
    catalog.setUpstream([
      row('gpt-5.6-terra', {
        supports: true,
        onlyReasoning: false,
        supportedEfforts: ['low', 'medium', 'high'],
        canDisableThinking: true,
      }),
    ])
    let forwarded = ''
    shim = createWorkBuddyShim({
      store: {
        current: async () => credential,
        resolve: async () => credential,
        status: async () => ({ state: 'signed-in' }),
        importCredential: async (value: WorkBuddyCredential) => value,
        logout: async () => {},
      },
      client: {
        chatStream: async (_credential, bodyJson: string) => {
          forwarded = bodyJson
          return {
            ok: true,
            response: new Response('data: [DONE]\n\n', {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            }),
          }
        },
      },
      catalog,
    })
    await shim.ready
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${shim.token()}`,
      },
      body: JSON.stringify({ ...baseBody, model: 'gpt-5.6-terra' }),
    })
    await res.text()
    expect(JSON.parse(forwarded)).not.toHaveProperty('reasoning_effort')
  })
})
