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

let shim: WorkBuddyShim | undefined

afterEach(async () => {
  await shim?.close()
  shim = undefined
})

/** Start a shim over `rows` and return the request body it forwarded upstream. */
async function postChat(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const catalog = new WorkBuddyCatalog({ scope: 'all' })
  catalog.setUpstream([onlyReasoningRow])
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
