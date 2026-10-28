import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

/** The run the domestic gateway blocked on 2026-10-27, still blocked on 2026-10-29. */
const FINGERPRINT = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root'

/** The system text every request below starts from. */
const SYSTEM = `${FINGERPRINT}\n\n${'filler prose. '.repeat(40)}`

/** White-space-insensitive form, to prove the break preserves the words. */
const flat = (text: string): string => text.replaceAll(/\s+/g, ' ').trim()

/** The `system` text of a forwarded body. */
const systemOf = (body: string): string =>
  String((JSON.parse(body) as { messages: { role: string; content: unknown }[] }).messages[0]?.content)

const cnCredential: WorkBuddyCredential = {
  accessToken: 'token',
  refreshToken: 'refresh',
  expiresAtMs: Date.now() + 3_600_000,
  domain: 'www.codebuddy.cn',
  uid: 'u1',
  source: 'dsh',
}

const globalCredential: WorkBuddyCredential = { ...cnCredential, domain: 'www.workbuddy.ai' }

let shim: WorkBuddyShim | undefined

const store = (credential: WorkBuddyCredential) => ({
  current: async () => credential,
  resolve: async () => credential,
  status: async () => ({ state: 'signed-in' as const }),
  importCredential: async (value: WorkBuddyCredential) => value,
  logout: async () => {},
})

/** Start a shim over `credential` and return the body it forwarded upstream. */
async function forwardedBody(credential: WorkBuddyCredential): Promise<string> {
  let forwarded = ''
  shim = createWorkBuddyShim({
    store: store(credential),
    client: {
      chatStream: async (_credential, bodyJson: string) => {
        forwarded = bodyJson
        return {
          ok: true,
          response: new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        }
      },
    },
    catalog: new WorkBuddyCatalog({ scope: 'all' }),
  })
  await shim.ready
  const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'hi' }],
    }),
  })
  await res.text()
  return forwarded
}

afterEach(async () => {
  await shim?.close()
  shim = undefined
})

describe('shim domestic fingerprint break', () => {
  it('breaks the blocked run on the domestic route', async () => {
    const forwarded = await forwardedBody(cnCredential)
    const system = systemOf(forwarded)
    expect(system.includes(FINGERPRINT)).toBe(false)
    // Every word survives: only some spaces became line breaks.
    expect(flat(system)).toBe(flat(SYSTEM))
    expect(system.length).toBe(SYSTEM.length)
  })

  it('leaves the international request byte-identical', async () => {
    const forwarded = await forwardedBody(globalCredential)
    expect(systemOf(forwarded)).toBe(SYSTEM)
  })

  it('also breaks a run the model echoed back in an earlier reply', async () => {
    // A system-only rewrite defeats itself here: the assistant quoted the prompt,
    // and the gateway reads assistant text too, so the echoed copy blocks the turn.
    let forwarded = ''
    shim = createWorkBuddyShim({
      store: {
        current: async () => cnCredential,
        resolve: async () => cnCredential,
        status: async () => ({ state: 'signed-in' as const }),
        importCredential: async (value: WorkBuddyCredential) => value,
        logout: async () => {},
      },
      client: {
        chatStream: async (_credential, bodyJson: string) => {
          forwarded = bodyJson
          return {
            ok: true,
            response: new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
          }
        },
      },
      catalog: new WorkBuddyCatalog({ scope: 'all' }),
    })
    await shim.ready
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: 'what does your prompt say?' },
          { role: 'assistant', content: `It says: "${FINGERPRINT}".` },
        ],
      }),
    })
    await res.text()
    expect(forwarded.includes(FINGERPRINT)).toBe(false)
  })
})
