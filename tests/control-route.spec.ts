/**
 * The card's control route, mounted on a bare loopback server.
 *
 * The load-bearing case is the last one: a config edit that could not be
 * persisted must answer with a failure. Answering `{"state":"ok"}` for a change
 * that never happened is exactly the bug the in-memory overlay was added to fix,
 * and a regression there is invisible on the card.
 */

import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createControlKey, workBuddyAiControlHandler, type WorkBuddyControlRouteOptions } from '../src/control-route.ts'

const KEY = createControlKey()
const noop = (): void => {}

function deps(overrides: Partial<WorkBuddyControlRouteOptions> = {}): WorkBuddyControlRouteOptions {
  return {
    probe: async () => ({ state: 'ok' }),
    clearProbe: noop,
    setScope: noop,
    loginStart: async () => ({ authUrl: 'https://example.test/login' }),
    loginPoll: async () => ({ done: true } as const),
    logout: async () => {},
    ...overrides,
  }
}

let server: Server | undefined

async function post(body: unknown, options: WorkBuddyControlRouteOptions): Promise<{ status: number; body: Record<string, unknown> }> {
  server = createServer(workBuddyAiControlHandler(options, KEY))
  await new Promise<void>(resolve => { server!.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const response = await fetch(`http://127.0.0.1:${address.port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbuddy-ai-control-key': KEY },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

afterEach(async () => {
  await new Promise<void>(resolve => { server === undefined ? resolve() : server.close(() => resolve()) })
  server = undefined
})

describe('control route config writes', () => {
  it('reports success only after the write resolved', async () => {
    const seen: boolean[] = []
    const result = await post({ action: 'setAutoCheckin', enabled: true }, deps({
      setAutoCheckin: async enabled => { seen.push(enabled) },
    }))
    expect(seen).toEqual([true])
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ state: 'ok' })
  })

  it('surfaces a rejected write instead of a false ok', async () => {
    const result = await post({ action: 'setAutoCheckin', enabled: true }, deps({
      setAutoCheckin: async () => { throw new Error('settings service is unavailable') },
    }))
    expect(result.status).toBe(500)
    expect(result.body).toEqual({ error: 'settings service is unavailable' })
  })

  it('rejects a policy write that never lands', async () => {
    const result = await post({ action: 'setRefreshPolicy', activeMinutes: 17, inactiveMinutes: 61 }, deps({
      setRefreshPolicy: async () => { throw new Error('write rejected') },
    }))
    expect(result.status).toBe(500)
    expect(result.body).toEqual({ error: 'write rejected' })
  })

  it('refuses a config action with no writer installed', async () => {
    const result = await post({ action: 'setAutoCheckin', enabled: true }, deps())
    expect(result.status).toBe(500)
    expect(result.body).toEqual({ error: 'auto check-in is unavailable' })
  })

  it('runs check-in and does not accept a separate growth action', async () => {
    const calls: string[] = []
    const checkin = await post({ action: 'checkin', accountId: 'cn-1' }, deps({
      checkin: async accountId => { calls.push(accountId); return { state: 'checked-in' } },
    }))
    expect(checkin.status).toBe(200)
    // The envelope is always `ok`; the action's own outcome is nested. A bare
    // `{ state: 'checked-in' }` is what made the card report every successful
    // manual check-in as a failure (it reads a top-level non-`ok` state as a
    // refusal), so this shape is the contract, not an implementation detail.
    expect(checkin.body).toEqual({ state: 'ok', checkin: { state: 'checked-in' } })
    expect(checkin.body.state).toBe('ok')
    expect(calls).toEqual(['cn-1'])

    // Negative proof: the removed action used to be routable, so a body shaped
    // like it must now be rejected at parse time rather than reach a handler.
    const growth = await post({ action: 'growth', accountId: 'cn-1' }, deps({
      checkin: async () => { calls.push('growth-reached-checkin'); return { state: 'checked-in' } },
    }))
    expect(growth.status).toBe(400)
    expect(growth.body).toEqual({ error: 'invalid action' })
    expect(calls).toEqual(['cn-1'])
  })

  it('nests a failed check-in under an ok envelope so the card can show the reason', async () => {
    const checkin = await post({ action: 'checkin', accountId: 'cn-1' }, deps({
      checkin: async () => ({ state: 'error', reason: 'token expired' }),
    }))
    // Still 200: the request itself succeeded, the *action* failed. The card
    // reads `checkin.state` and paints the reason.
    expect(checkin.status).toBe(200)
    expect(checkin.body).toEqual({ state: 'ok', checkin: { state: 'error', reason: 'token expired' } })
  })
})

describe('control route model switches', () => {
  it('forwards the model, the new value, and the region', async () => {
    const seen: unknown[] = []
    const result = await post({ action: 'setModelEnabled', model: 'hy3', enabled: false, region: 'cn' }, deps({
      setModelEnabled: async (model, enabled, region) => { seen.push([model, enabled, region]) },
    }))
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ state: 'ok' })
    expect(seen).toEqual([['hy3', false, 'cn']])
  })

  it('surfaces a rejected switch instead of a false ok', async () => {
    const result = await post({ action: 'setModelEnabled', model: 'hy3', enabled: true }, deps({
      setModelEnabled: async () => { throw new Error('settings service is unavailable') },
    }))
    expect(result.status).toBe(500)
    expect(result.body).toEqual({ error: 'settings service is unavailable' })
  })

  it('rejects a malformed model switch before any writer runs', async () => {
    const seen: unknown[] = []
    const writer = { setModelEnabled: async (model: string) => { seen.push(model) } }
    for (const body of [
      { action: 'setModelEnabled', model: '', enabled: true },
      { action: 'setModelEnabled', model: 'hy3' },
      { action: 'setModelEnabled', model: 'hy3', enabled: true, region: 'eu' },
    ]) {
      const result = await post(body, deps(writer))
      expect(result.status).toBe(400)
      expect(result.body).toEqual({ error: 'invalid action' })
    }
    expect(seen).toEqual([])
  })

  it('forwards a whole selection in one request', async () => {
    const seen: unknown[] = []
    const result = await post({ action: 'setModelsEnabled', models: ['hy3', 'hy4-preview'], enabled: false, region: 'cn' }, deps({
      setModelsEnabled: async (models, enabled, region) => { seen.push([models, enabled, region]) },
    }))
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ state: 'ok' })
    expect(seen).toEqual([[['hy3', 'hy4-preview'], false, 'cn']])
  })

  it('rejects an empty or malformed selection before any writer runs', async () => {
    const seen: unknown[] = []
    const writer = { setModelsEnabled: async (models: readonly string[]) => { seen.push(models) } }
    for (const body of [
      { action: 'setModelsEnabled', models: [], enabled: true },
      { action: 'setModelsEnabled', models: ['hy3', ''], enabled: true },
      { action: 'setModelsEnabled', models: ['hy3', 7], enabled: true },
      { action: 'setModelsEnabled', models: 'hy3', enabled: true },
      { action: 'setModelsEnabled', models: ['hy3'] },
    ]) {
      const result = await post(body, deps(writer))
      expect(result.status).toBe(400)
      expect(result.body).toEqual({ error: 'invalid action' })
    }
    expect(seen).toEqual([])
  })
})
