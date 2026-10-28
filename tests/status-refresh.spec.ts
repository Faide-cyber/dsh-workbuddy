import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyAccountStore } from '../src/auth.ts'
import type { WorkBuddyCredentialStoreLike } from '../src/auth.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { workBuddyAiStatusHandler } from '../src/web-status.ts'
import type { WorkBuddyCredits } from '../src/upstream.ts'

const cleanup: string[] = []
let server: Server | undefined

afterEach(async () => {
  await new Promise<void>(resolve => {
    if (server === undefined) { resolve(); return }
    server.close(() => resolve())
    server.closeAllConnections()
  })
  server = undefined
  while (cleanup.length > 0) {
    const path = cleanup.pop()
    if (path !== undefined) await rm(path, { recursive: true, force: true })
  }
})

/**
 * Mount the real status route over a real account store and count upstream reads.
 *
 * The bug this guards: the card's 刷新 button calls the same GET as its 60-second
 * poll, and the host answers that GET from a per-account credit cache whose TTL is
 * the user's active/inactive refresh policy. Clicking refresh therefore handed
 * back the cached figure — the button looked like a no-op for up to 15 minutes.
 * `?refresh=1` is now the difference between the two callers.
 */
async function mountStatusRoute(): Promise<{ url: string; reads: () => number }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-ai-status-'))
  cleanup.push(dir)
  const store = new WorkBuddyAccountStore({
    region: 'cn',
    ownPath: join(dir, 'cn-auth.json'),
    // Without an explicit (missing) path the store would import this machine's real
    // desktop WorkBuddy credential as a second account, making `reads` depend on
    // the host. The override keeps the fixture to the one account this test seeds.
    desktopPath: join(dir, 'no-desktop-auth.json'),
    refresh: async credential => ({ accessToken: credential.accessToken, expiresInSec: 3600 }),
  })
  await store.importCredential({
    accessToken: 'token', refreshToken: '', expiresAtMs: Date.now() + 3_600_000,
    domain: 'www.codebuddy.cn', uid: 'u-status', source: 'dsh',
  })

  let reads = 0
  const client = {
    fetchCredits: async (): Promise<WorkBuddyCredits> => {
      reads += 1
      return { total: reads * 1000, accounts: [] }
    },
    // Absent behaviour would be fine, but the region option type requires the hook.
    // Returning `undefined` leaves every account's edition untouched.
    fetchAccountEdition: async (): Promise<undefined> => undefined,
  }
  const catalog = new WorkBuddyCatalog({ scope: 'free' })
  server = createServer(workBuddyAiStatusHandler({
    // A credentialed top-level store would add one *uncached* upstream read per
    // request, drowning the regional cache behaviour this test is about. Signing
    // that layer out leaves only the region-scoped reads being counted.
    store: {
      status: async () => ({ state: 'signed-out' as const }),
      current: async () => undefined,
      resolve: async () => { throw new Error('status route never resolves a credential') },
      importCredential: async (value: never) => value,
      logout: async () => {},
    } as unknown as WorkBuddyCredentialStoreLike,
    client,
    catalog,
    regions: { cn: { region: 'cn', store, client, catalog } },
    // A long TTL is the point: every poll inside it must be served from cache.
    refreshPolicy: () => ({ activeMinutes: 15, inactiveMinutes: 60 }),
  }))
  await new Promise<void>(resolve => { server!.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}/plugins/dsh-workbuddy/status`, reads: () => reads }
}

function creditsOf(document: unknown): number | undefined {
  const regions = (document as { regions?: { region: string; accounts: { credits?: { total: number } }[] }[] }).regions
  return regions?.find(region => region.region === 'cn')?.accounts[0]?.credits?.total
}

describe('status route credit freshness', () => {
  it('serves the poll from cache but re-reads when the card asks to refresh', async () => {
    const { url, reads } = await mountStatusRoute()

    // Each answered request costs at least one upstream read, so the assertions
    // below compare *deltas* rather than absolutes: the exact baseline depends on
    // how many credit blocks the document assembles (region + the top-level one).
    const first = await (await fetch(url)).json()
    expect(creditsOf(first)).toBe(1000)
    const afterFirst = reads()

    // The 60-second poll: still inside the 15-minute window, so no new upstream read.
    const second = await (await fetch(url)).json()
    expect(creditsOf(second)).toBe(1000)
    expect(reads()).toBe(afterFirst)

    // 刷新: the same route, but it must reach the upstream at least once more.
    const forced = await (await fetch(`${url}?refresh=1`)).json()
    expect(creditsOf(forced)).toBe(2000)
    const afterForced = reads()
    expect(afterForced).toBeGreaterThan(afterFirst)

    const forcedAgain = await (await fetch(`${url}?refresh=1`)).json()
    expect(creditsOf(forcedAgain)).toBe(3000)
    const afterForcedAgain = reads()
    expect(afterForcedAgain).toBeGreaterThan(afterForced)

    // And a plain poll after a forced read is still served from the fresh cache.
    await (await fetch(url)).json()
    expect(reads()).toBe(afterForcedAgain)
  })
})
