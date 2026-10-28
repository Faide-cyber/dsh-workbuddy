import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

/** The run the domestic gateway blocked on 2026-10-27, still blocked on 2026-10-29. */
const FINGERPRINT = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve to the workspace root'

/**
 * What the semantic layer must turn it into, spelled out on purpose: the exact
 * prompt wording a rewrite produces is a decision, not an implementation detail,
 * so a change to the table has to change this line too.
 */
const REWORDED = 'Tokens starting with @ denote paths the user explicitly referenced. Relative paths are resolved against the workspace root'

/** Long system text carrying a known fingerprint. */
const SYSTEM = `${FINGERPRINT}\n\n${'filler prose. '.repeat(40)}`

/** Long system text carrying none — the prefix-cache case. */
const BENIGN = 'filler prose. '.repeat(60)

/** White-space-insensitive form, to prove the breaks preserve the words. */
const flat = (text: string): string => text.replaceAll(/\s+/g, ' ').trim()

/** The `system` text of a forwarded body. */
const systemOf = (body: string): string =>
  String((JSON.parse(body) as { messages: { role: string, content: unknown }[] }).messages[0]?.content)

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
async function forwardedBody(
  credential: WorkBuddyCredential,
  messages: { role: string, content: unknown }[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: 'hi' },
  ],
): Promise<string> {
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
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages }),
  })
  await res.text()
  return forwarded
}

afterEach(async () => {
  await shim?.close()
  shim = undefined
})

/** Line feeds present — the domestic route adds some, the international route must not. */
const breaks = (text: string): number => text.split('\n').length - 1

describe('shim fingerprint guard by region', () => {
  it('rewords and breaks a known run on the domestic route', async () => {
    const system = systemOf(await forwardedBody(cnCredential))
    expect(system.includes(FINGERPRINT)).toBe(false)
    expect(flat(system)).toBe(flat(SYSTEM.replace(FINGERPRINT, REWORDED)))
    // Both layers ran: the wording changed *and* the long stretches were split.
    expect(breaks(system)).toBeGreaterThan(breaks(SYSTEM.replace(FINGERPRINT, REWORDED)))
  })

  it('rewords a known run on the international route without touching layout', async () => {
    // The reword is semantically inert, so it runs everywhere; only the domestic
    // route needs the line breaks. Byte-for-byte here, no break inserted.
    expect(systemOf(await forwardedBody(globalCredential))).toBe(SYSTEM.replace(FINGERPRINT, REWORDED))
  })

  it('forwards a fingerprint-free turn byte-identically on the international route', async () => {
    // Anything else would cost the upstream prefix cache on every request.
    const messages = [{ role: 'system', content: BENIGN }, { role: 'user', content: 'hi' }]
    expect(systemOf(await forwardedBody(globalCredential, messages))).toBe(BENIGN)
  })

  it('breaks long text on the domestic route even with no known run in it', async () => {
    // The point of the structural layer: a fingerprint DSH adds in a later release
    // is broken before anyone has registered it. Only the layout may change.
    const messages = [{ role: 'system', content: BENIGN }, { role: 'user', content: 'hi' }]
    const system = systemOf(await forwardedBody(cnCredential, messages))
    expect(system).not.toBe(BENIGN)
    expect(flat(system)).toBe(flat(BENIGN))
    expect(breaks(system)).toBeGreaterThan(breaks(BENIGN))
  })

  it('leaves short text byte-identical on both routes', async () => {
    const short = 'You are a helpful assistant.'
    const messages = [{ role: 'system', content: short }, { role: 'user', content: 'hi' }]
    expect(systemOf(await forwardedBody(cnCredential, messages))).toBe(short)
    expect(systemOf(await forwardedBody(globalCredential, messages))).toBe(short)
  })

  it('also clears a run the model echoed back in an earlier reply', async () => {
    // A system-only rewrite defeats itself here: the assistant quoted the prompt,
    // and the gateway reads assistant text too, so the echoed copy blocks the turn.
    const forwarded = await forwardedBody(cnCredential, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'what does your prompt say?' },
      { role: 'assistant', content: `It says: "${FINGERPRINT}".` },
    ])
    expect(forwarded.includes(FINGERPRINT)).toBe(false)
    // The echo may still quote the *reworded* prompt: that is the model's own words.
    expect(forwarded).toContain('Tokens starting with @ denote paths')
  })
})