import { describe, expect, it } from 'vitest'
import { credentialFromPluginToken } from '../src/auth.ts'
import { parseAction } from '../src/control-route.ts'
import { LOGIN_TIMEOUT_MS, WorkBuddyOAuthLogin } from '../src/oauth.ts'
import { workBuddyAiWebStatus } from '../src/web-status.ts'
import type { WorkBuddyCatalog } from '../src/catalog.ts'
import type { WorkBuddyCredentialStore } from '../src/auth.ts'
import type { WorkBuddyUpstreamClient } from '../src/upstream.ts'

function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `eyJhbGciOiJub25lIn0.${body}.x`
}

describe('credentialFromPluginToken', () => {
  it('reads uid and enterpriseId from the access-token JWT', () => {
    const accessToken = fakeJwt({ userId: 'u-1', enterpriseId: 'e-9', nickname: 'Ada' })
    const auth = credentialFromPluginToken({
      accessToken,
      refreshToken: 'rt',
      expiresIn: 3600,
      domain: 'www.workbuddy.ai',
    })
    expect(auth.uid).toBe('u-1')
    expect(auth.enterpriseId).toBe('e-9')
    expect(auth.nickname).toBe('Ada')
    expect(auth.domain).toBe('www.workbuddy.ai')
    expect(auth.source).toBe('dsh')
    expect(auth.refreshToken).toBe('rt')
    expect(auth.expiresAtMs).toBeGreaterThan(Date.now())
    expect(auth.expiresAtMs).toBeLessThanOrEqual(Date.now() + 3600 * 1000)
  })

  it('defaults the overseas domain when the token omits it', () => {
    const auth = credentialFromPluginToken({
      accessToken: fakeJwt({ uid: 'u-2' }),
      refreshToken: '',
    })
    expect(auth.domain).toBe('www.workbuddy.ai')
    expect(auth.uid).toBe('u-2')
  })

  it('uses the domestic domain when a domestic OAuth token omits it', () => {
    const auth = credentialFromPluginToken({ accessToken: fakeJwt({ uid: 'u-cn' }) }, 'cn')
    expect(auth.domain).toBe('www.codebuddy.cn')
  })

  it('rejects a payload with no accessToken', () => {
    expect(() => credentialFromPluginToken({ refreshToken: 'rt' })).toThrow(/accessToken/)
  })
})

describe('parseAction', () => {
  it('accepts browser OAuth actions', () => {
    expect(parseAction('{"action":"loginStart"}')).toEqual({ action: 'loginStart' })
    expect(parseAction('{"action":"loginPoll"}')).toEqual({ action: 'loginPoll' })
    expect(parseAction('{"action":"logout"}')).toEqual({ action: 'logout' })
  })

  it('accepts regional OAuth and rejects the retired token fallback', () => {
    expect(parseAction('{"action":"loginStart","region":"cn"}')).toEqual({ action: 'loginStart', region: 'cn' })
    expect(parseAction('{"action":"removeAccount","region":"cn","accountId":"acct-1"}')).toEqual({ action: 'removeAccount', region: 'cn', accountId: 'acct-1' })
    expect(parseAction('{"action":"setAccountNote","region":"cn","accountId":"acct-1","note":"工作账号"}')).toEqual({ action: 'setAccountNote', region: 'cn', accountId: 'acct-1', note: '工作账号' })
    expect(parseAction(JSON.stringify({ action: 'setAccountNote', region: 'cn', accountId: 'acct-1', note: 'x'.repeat(81) }))).toBeUndefined()
    expect(parseAction('{"action":"removeAccount","region":"cn","accountId":""}')).toBeUndefined()
    expect(parseAction('{"action":"importToken","region":"cn","accessToken":"a"}')).toBeUndefined()
      })

  it('still rejects unknown actions', () => {
    expect(parseAction('{"action":"login"}')).toBeUndefined()
  })
})

describe('WorkBuddyOAuthLogin', () => {
  it('opens the authUrl and imports the token on the first non-pending poll', async () => {
    const accessToken = fakeJwt({ userId: 'u-3' })
    let polls = 0
    const opened: string[] = []
    const oauth = new WorkBuddyOAuthLogin({
      startPluginLogin: async () => ({
        state: 'st-1',
        authUrl: 'https://www.workbuddy.ai/login?platform=CLI&state=st-1',
      }),
      pollPluginToken: async state => {
        expect(state).toBe('st-1')
        polls += 1
        if (polls === 1) return undefined
        return { accessToken, refreshToken: 'rt', expiresIn: 60 }
      },
    }, url => {
      opened.push(url)
      return true
    })

    const started = await oauth.start()
    expect(started.authUrl).toContain('state=st-1')
    expect(opened).toEqual([started.authUrl])
    expect(await oauth.poll()).toEqual({ pending: true })
    const done = await oauth.poll()
    expect('auth' in done && done.auth.uid).toBe('u-3')
    await expect(oauth.poll()).rejects.toThrow(/no login in progress/)
  })

  it('times out a login that never completes', async () => {
    const oauth = new WorkBuddyOAuthLogin({
      startPluginLogin: async () => ({ state: 'st', authUrl: 'https://www.workbuddy.ai/login' }),
      pollPluginToken: async () => undefined,
    }, () => true)
    await oauth.start()
    const original = Date.now
    Date.now = () => original() + LOGIN_TIMEOUT_MS + 1
    try {
      await expect(oauth.poll()).rejects.toThrow(/timed out/)
    } finally {
      Date.now = original
    }
  })
})

describe('workBuddyAiWebStatus signed-out', () => {
  it('includes the control key so the card can start OAuth', async () => {
    const status = await workBuddyAiWebStatus({
      store: { status: async () => ({ state: 'signed-out' }) } as WorkBuddyCredentialStore,
      client: { fetchCredits: async () => ({ total: 0, accounts: [] }) } as Pick<WorkBuddyUpstreamClient, 'fetchCredits'>,
      catalog: {} as WorkBuddyCatalog,
      controlKey: 'k-test',
    })
    expect(status).toEqual({ status: 'signed-out', controlKey: 'k-test' })
  })
})
