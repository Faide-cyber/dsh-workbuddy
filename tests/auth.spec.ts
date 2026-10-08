import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyAccountStore } from '../src/auth.ts'

const cleanup: string[] = []
afterEach(async () => {
  while (cleanup.length > 0) {
    const path = cleanup.pop()
    if (path !== undefined) await rm(path, { recursive: true, force: true })
  }
})

describe('WorkBuddyAccountStore', () => {
  it('keeps explicit selection stable while exposing multiple token-free accounts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-ai-auth-'))
    cleanup.push(dir)
    const store = new WorkBuddyAccountStore({
      region: 'cn',
      ownPath: join(dir, 'cn-auth.json'),
      refresh: async credential => ({ accessToken: credential.accessToken, expiresInSec: 3600 }),
    })
    const expiresAtMs = Date.now() + 60 * 60 * 1000
    await store.importCredential({ accessToken: 'token-a', refreshToken: '', expiresAtMs, domain: '', uid: 'u-a', source: 'dsh' })
    await store.importCredential({ accessToken: 'token-b', refreshToken: '', expiresAtMs, domain: '', uid: 'u-b', source: 'dsh' })
    const accounts = await store.accounts()
    expect(accounts).toHaveLength(2)
    expect(accounts.every(account => account.region === 'cn')).toBe(true)
    const first = accounts[0]!
    await store.select(first.id)
    await store.setNote(first.id, '主账号')
    expect((await store.accounts()).find(account => account.id === first.id)?.note).toBe('主账号')
    expect((await store.current())?.accessToken).toBe('token-a')
    expect((await store.resolveFor(accounts[1]!.id)).accessToken).toBe('token-b')
    expect((await store.current())?.accessToken).toBe('token-a')
    const restored = new WorkBuddyAccountStore({
      region: 'cn',
      ownPath: join(dir, 'cn-auth.json'),
      refresh: async credential => ({ accessToken: credential.accessToken, expiresInSec: 3600 }),
    })
    expect((await restored.accounts()).find(account => account.id === first.id)?.note).toBe('主账号')
    await restored.setNote(first.id, ' ')
    expect((await restored.accounts()).find(account => account.id === first.id)?.note).toBeUndefined()
  })

  it('returns the normalized note so the card can echo it without re-reading', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-ai-auth-'))
    cleanup.push(dir)
    const store = new WorkBuddyAccountStore({
      region: 'cn',
      ownPath: join(dir, 'cn-auth.json'),
      refresh: async credential => ({ accessToken: credential.accessToken, expiresInSec: 3600 }),
    })
    await store.importCredential({ accessToken: 'token-a', refreshToken: '', expiresAtMs: Date.now() + 3_600_000, domain: '', uid: 'u-a', source: 'dsh' })
    const id = (await store.accounts())[0]!.id
    // The echo must equal what a later read sees, or the card paints one name
    // and the next poll replaces it with another.
    expect(await store.setNote(id, '  主力  号  ')).toBe('主力 号')
    expect((await store.accounts())[0]!.note).toBe('主力 号')
    // An empty save clears the note, so the card falls back to the nickname.
    expect(await store.setNote(id, '   ')).toBeUndefined()
    expect((await store.accounts())[0]!.note).toBeUndefined()
    // An unknown account is a failure, not a silent no-op that echoes a name
    // the host never stored.
    await expect(store.setNote('no-such-account', 'x')).rejects.toThrow(/not found/u)
  })

  it('uses an access-token-only import without trying an unavailable refresh', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-ai-auth-'))
    cleanup.push(dir)
    const store = new WorkBuddyAccountStore({
      region: 'global',
      ownPath: join(dir, 'global-auth.json'),
      refresh: async () => { throw new Error('refresh should not run') },
    })
    await store.importCredential({ accessToken: 'opaque-access-token', refreshToken: '', expiresAtMs: 0, domain: '', uid: 'opaque-user', source: 'dsh' })
    expect((await store.resolve())?.accessToken).toBe('opaque-access-token')
  })
})
