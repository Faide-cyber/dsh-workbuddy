/**
 * Control route: the only state-changing endpoint the plugin exposes.
 *
 * Two guards, because they stop different things:
 *
 * 1. **Trusted Host + Origin**, shared with the status route. Loopback is
 *    always allowed; extra LAN authorities must be listed in `allowedHosts`.
 *    This drops DNS-rebinding pages, whose Host is the attacker's domain.
 * 2. **An in-process random key**, minted per process and handed only to the
 *    same-origin card. Loopback alone is *not* authentication — any local process
 *    can write `Host: 127.0.0.1` — so a route that can spend the user's credit
 *    (a probe) or expose paid models must prove the caller was told the key.
 *
 * The route never accepts a prompt, a model id outside the live catalog, or a
 * sentinel from the browser: a probe request is assembled entirely host-side.
 *
 * @module dsh-workbuddy/control-route
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { requestIsTrusted } from './loopback.ts'
import { WORKBUDDY_CONTROL_KEY_HEADER, WORKBUDDY_CONTROL_PATH } from './status-paths.ts'
import type { WorkBuddyControlAction, WorkBuddyModelScope } from './status-paths.ts'

/** Largest control body accepted; these payloads are a few dozen bytes. */
const MAX_BODY_BYTES = 4096

/** Constructor dependencies. */
export interface WorkBuddyControlRouteOptions {
  /**
   * Run a probe for one model. Resolves to a short status string, never a raw
   * upstream body.
   */
  probe: (modelId: string) => Promise<{ state: string; reason?: string }>
  /** Drop every recorded observation. */
  clearProbe: () => void
  /** Switch the billing policy; the caller re-registers the affected catalog. */
  setScope: (scope: WorkBuddyModelScope, region?: 'cn' | 'global') => void
  /** Start a browser OAuth login; returns the URL the card should open. */
  loginStart: (region?: 'cn' | 'global') => Promise<{ authUrl: string }>
  /** Poll the in-flight login; `pending` until the browser finishes. */
  loginPoll: (region?: 'cn' | 'global') => Promise<{ pending: true } | { done: true }>
  /** Drop the plugin-owned credential copy. */
  logout: (region?: 'cn' | 'global') => Promise<void>
  selectAccount?: (region: 'cn' | 'global', accountId: string) => Promise<void>
  removeAccount?: (region: 'cn' | 'global', accountId: string) => Promise<void>
  /** Store a note; resolves with the normalized value the host kept (null = cleared). */
  setAccountNote?: (region: 'cn' | 'global', accountId: string, note: string) => Promise<string | undefined>
  setCheckinEnabled?: (accountId: string, enabled: boolean) => Promise<void>
  checkin?: (accountId: string) => Promise<{ state: string; reason?: string; claimed?: number }>
  connectivity?: (region: 'cn' | 'global', accountId?: string) => Promise<{ state: string; reason?: string }>
  setRefreshPolicy?: (activeMinutes: number, inactiveMinutes: number) => Promise<void>
  setAutoCheckin?: (enabled: boolean) => Promise<void>
  /**
   * Turn one model's picker switch on or off. Only the picker list changes; a
   * session that already selected the model keeps resolving and sending it.
   */
  setModelEnabled?: (model: string, enabled: boolean, region?: 'cn' | 'global') => Promise<void>
  /**
   * The same switch for many models at once. Select-all must not become one
   * request per row: each write rewrites the settings file.
   */
  setModelsEnabled?: (models: readonly string[], enabled: boolean, region?: 'cn' | 'global') => Promise<void>
  /**
   * Extra Host/Origin authorities for LAN DSH Web. Read live so a settings
   * edit applies without remounting the route. Default empty = loopback only.
   */
  allowedHosts?: () => readonly string[]
}

/** Mint the per-process control key. */
export function createControlKey(): string {
  return randomBytes(24).toString('hex')
}

/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined || presented.length !== expected.length) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function safeControlError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

/** Read the request body with a hard ceiling. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Parse and shape-check an action; unknown fields are ignored, not trusted. */
export function parseAction(text: string): WorkBuddyControlAction | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const wrapped = parsed as Record<string, unknown>
  const action = wrapped['action']
  if (action === 'clearProbe') return { action: 'clearProbe' }
  if (action === 'setScope') {
    const scope = wrapped['scope']
    // Only the two known spellings are accepted; a typo must not silently
    // resolve to the permissive branch.
    if (scope !== 'free' && scope !== 'all') return undefined
    const region = wrapped['region']
    if (region !== undefined && region !== 'cn' && region !== 'global') return undefined
    return { action: 'setScope', scope, ...region === undefined ? {} : { region } }
  }
  if (action === 'probe') {
    const model = wrapped['model']
    if (typeof model !== 'string' || model.trim() === '') return undefined
    return { action: 'probe', model: model.trim() }
  }
  if (action === 'loginStart' || action === 'loginPoll' || action === 'logout') {
    const region = wrapped['region']
    return region === undefined
      ? { action }
      : region === 'cn' || region === 'global' ? { action, region } : undefined
  }
  if (action === 'selectAccount' || action === 'removeAccount') {
    const region = wrapped['region']
    const accountId = wrapped['accountId']
    if ((region !== 'cn' && region !== 'global') || typeof accountId !== 'string' || accountId.trim() === '') return undefined
    return { action, region, accountId: accountId.trim() }
  }
  if (action === 'setAccountNote') {
    const region = wrapped['region']
    const accountId = wrapped['accountId']
    const note = wrapped['note']
    if ((region !== 'cn' && region !== 'global') || typeof accountId !== 'string' || accountId.trim() === ''
      || typeof note !== 'string' || note.length > 80) return undefined
    return { action, region, accountId: accountId.trim(), note: note.trim() }
  }
  if (action === 'setCheckinEnabled') {
    const accountId = wrapped['accountId']
    const enabled = wrapped['enabled']
    if (typeof accountId !== 'string' || accountId.trim() === '' || typeof enabled !== 'boolean') return undefined
    return { action, accountId: accountId.trim(), enabled }
  }
  if (action === 'checkin') {
    const accountId = wrapped['accountId']
    if (typeof accountId !== 'string' || accountId.trim() === '') return undefined
    return { action, accountId: accountId.trim() }
  }
  if (action === 'connectivity') {
    const region = wrapped['region']
    const accountId = wrapped['accountId']
    if (region !== 'cn' && region !== 'global') return undefined
    return { action, region, ...typeof accountId === 'string' && accountId.trim() !== '' ? { accountId: accountId.trim() } : {} }
  }
  if (action === 'setRefreshPolicy') {
    const activeMinutes = wrapped['activeMinutes']
    const inactiveMinutes = wrapped['inactiveMinutes']
    if (typeof activeMinutes !== 'number' || !Number.isFinite(activeMinutes) || activeMinutes < 1
      || typeof inactiveMinutes !== 'number' || !Number.isFinite(inactiveMinutes) || inactiveMinutes < 1) return undefined
    return { action, activeMinutes, inactiveMinutes }
  }
  if (action === 'setAutoCheckin' && typeof wrapped['enabled'] === 'boolean') {
    return { action, enabled: wrapped['enabled'] }
  }
  if (action === 'setModelEnabled') {
    const model = wrapped['model']
    const enabled = wrapped['enabled']
    const region = wrapped['region']
    if (typeof model !== 'string' || model.trim() === '' || typeof enabled !== 'boolean') return undefined
    if (region !== undefined && region !== 'cn' && region !== 'global') return undefined
    return { action, model: model.trim(), enabled, ...region === undefined ? {} : { region } }
  }
  if (action === 'setModelsEnabled') {
    const models = wrapped['models']
    const enabled = wrapped['enabled']
    const region = wrapped['region']
    if (!Array.isArray(models) || models.length === 0 || models.length > 500) return undefined
    const ids: string[] = []
    for (const model of models) {
      if (typeof model !== 'string' || model.trim() === '') return undefined
      ids.push(model.trim())
    }
    if (typeof enabled !== 'boolean') return undefined
    if (region !== undefined && region !== 'cn' && region !== 'global') return undefined
    return { action, models: ids, enabled, ...region === undefined ? {} : { region } }
  }
  return undefined
}

/**
 * The control route's handler, extracted so tests can mount it on a bare server
 * with a known key.
 */
export function workBuddyAiControlHandler(
  deps: WorkBuddyControlRouteOptions,
  key: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
    if (!requestIsTrusted({ headers: {
      ...req.headers.host === undefined ? {} : { host: req.headers.host },
      ...origin === undefined ? {} : { origin },
    } }, deps.allowedHosts?.() ?? [])) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (!keyMatches(key, req.headers[WORKBUDDY_CONTROL_KEY_HEADER] as string | undefined)) {
      json(res, 403, { error: 'invalid-control-key' })
      return
    }
    const body = await readBody(req)
    if (body === undefined) {
      json(res, 413, { error: 'body too large' })
      return
    }
    const action = parseAction(body)
    if (action === undefined) {
      json(res, 400, { error: 'invalid action' })
      return
    }
    try {
      switch (action.action) {
        case 'clearProbe':
          deps.clearProbe()
          json(res, 200, { state: 'cleared' })
          return
        case 'setScope':
          deps.setScope(action.scope, action.region)
          json(res, 200, { state: 'ok', scope: action.scope })
          return
        case 'probe':
          json(res, 200, await deps.probe(action.model))
          return
        case 'loginStart': {
          const started = await deps.loginStart(action.region)
          json(res, 200, { state: 'ok', authUrl: started.authUrl })
          return
        }
        case 'loginPoll': {
          const result = await deps.loginPoll(action.region)
          if ('pending' in result) {
            json(res, 200, { state: 'ok', pending: true })
            return
          }
          json(res, 200, { state: 'ok' })
          return
        }
        case 'logout':
          await deps.logout(action.region)
          json(res, 200, { state: 'ok' })
          return
        case 'selectAccount':
          if (deps.selectAccount === undefined) throw new Error('account selection is unavailable')
          await deps.selectAccount(action.region, action.accountId)
          json(res, 200, { state: 'ok' })
          return
        case 'removeAccount':
          if (deps.removeAccount === undefined) throw new Error('account removal is unavailable')
          await deps.removeAccount(action.region, action.accountId)
          json(res, 200, { state: 'ok' })
          return
        case 'setAccountNote': {
           if (deps.setAccountNote === undefined) throw new Error('account notes are unavailable')
           const note = await deps.setAccountNote(action.region, action.accountId, action.note)
           // Echo what was stored so the card can paint the row immediately
           // instead of re-reading the whole status document.
           json(res, 200, { state: 'ok', note: note ?? null })
           return
         }
         case 'setCheckinEnabled':
          if (deps.setCheckinEnabled === undefined) throw new Error('check-in settings are unavailable')
          await deps.setCheckinEnabled(action.accountId, action.enabled)
          json(res, 200, { state: 'ok' })
          return
        case 'checkin': {
          if (deps.checkin === undefined) throw new Error('check-in is unavailable')
          // Nested under `state: 'ok'` on purpose: the card reads a top-level
          // `state` other than `ok` as a refusal (probes answer that way), so a
          // bare `{ state: 'checked-in' }` would be reported as a failure.
          json(res, 200, { state: 'ok', checkin: await deps.checkin(action.accountId) })
          return
        }
        case 'connectivity':
          if (deps.connectivity === undefined) throw new Error('connectivity test is unavailable')
          json(res, 200, await deps.connectivity(action.region, action.accountId))
          return
        case 'setRefreshPolicy':
          if (deps.setRefreshPolicy === undefined) throw new Error('refresh policy is unavailable')
          await deps.setRefreshPolicy(action.activeMinutes, action.inactiveMinutes)
          json(res, 200, { state: 'ok' })
          return
        case 'setAutoCheckin':
          if (deps.setAutoCheckin === undefined) throw new Error('auto check-in is unavailable')
          await deps.setAutoCheckin(action.enabled)
          json(res, 200, { state: 'ok' })
          return
        case 'setModelEnabled':
          if (deps.setModelEnabled === undefined) throw new Error('model switches are unavailable')
          await deps.setModelEnabled(action.model, action.enabled, action.region)
          json(res, 200, { state: 'ok' })
          return
        case 'setModelsEnabled':
          if (deps.setModelsEnabled === undefined) throw new Error('model switches are unavailable')
          await deps.setModelsEnabled(action.models, action.enabled, action.region)
          json(res, 200, { state: 'ok' })
          return
      }
    } catch (error: unknown) {
      json(res, 500, { error: safeControlError(error) })
    }
  }
}

/** Mount the POST control route on an optional webServer context. */
export function registerWorkBuddyControlRoute(
  ctx: Context,
  deps: WorkBuddyControlRouteOptions,
  key: string,
): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_CONTROL_PATH,
      handler: workBuddyAiControlHandler(deps, key),
    })
    return () => {
      dispose()
    }
  }, 'dsh-workbuddy: control route')
}
