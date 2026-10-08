/**
 * Same-origin status route for the plugin card: sign-in state, token expiry, the
 * active billing policy, and remaining credit, fetched by the browser half. The
 * route answers loopback (or explicitly allowed LAN) browser requests only
 * and never carries token material.
 *
 * @module dsh-workbuddy/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WorkBuddyAccountStore, WorkBuddyCredentialStoreLike } from './auth.ts'
import type { WorkBuddyUpstreamClient, WorkBuddyRegion, WorkBuddyGrowthStatus } from './upstream.ts'
import { normalizeCredits } from './upstream.ts'
import type { WorkBuddyCatalog } from './catalog.ts'
import { requestIsTrusted } from './loopback.ts'
import { WORKBUDDY_STATUS_PATH } from './status-paths.ts'
import type { WorkBuddyWebAccount, WorkBuddyWebModelBadge, WorkBuddyWebProbeSection, WorkBuddyWebRegion, WorkBuddyWebStatus } from './status-paths.ts'

export { WORKBUDDY_STATUS_PATH } from './status-paths.ts'
export type { WorkBuddyWebStatus } from './status-paths.ts'

/** Constructor dependencies. */
export interface WorkBuddyStatusRegionOptions {
  region: WorkBuddyRegion
  store: WorkBuddyAccountStore
  client: Pick<WorkBuddyUpstreamClient, 'fetchCredits'>
  catalog: WorkBuddyCatalog
  probe?: () => WorkBuddyWebProbeSection
}

export interface WorkBuddyStatusRouteOptions {
  store: WorkBuddyCredentialStoreLike
  client: Pick<WorkBuddyUpstreamClient, 'fetchCredits'>
  /** Optional account-aware region stacks; global legacy fields remain supported. */
  regions?: Partial<Record<WorkBuddyRegion, WorkBuddyStatusRegionOptions>>
  refreshPolicy?: () => { activeMinutes: number; inactiveMinutes: number }
  autoCheckin?: () => boolean
  /** The live catalog; the card reads policy, prices, and provenance from it. */
  catalog: WorkBuddyCatalog
  /**
   * Compact probe state for the card. Optional so the status route keeps working
   * on its own in tests and headless profiles.
   */
  probe?: () => WorkBuddyWebProbeSection
  /** In-process key authorizing control writes. */
  controlKey?: string
  /**
   * Extra Host/Origin authorities for LAN DSH Web. Read live so a settings
   * edit applies without remounting the route. Default empty = loopback only.
   */
  allowedHosts?: () => readonly string[]
  /**
   * Latest per-account check-in and growth-plan reads, keyed by account id.
   * Live maps, not snapshots: the card polls, so a value written after this
   * route was built must still show up on the next request.
   */
  checkinStates?: ReadonlyMap<string, { todayCheckedIn?: boolean; todayCredit?: number; streakDays?: number }>
  growthStates?: ReadonlyMap<string, WorkBuddyGrowthStatus>
  /** Growth-center tasks still unclaimed per account, from the last sweep. */
  taskStates?: ReadonlyMap<string, { outstanding: number }>
}

/** Redact token-like content before it crosses to the browser. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * The request must be addressed to the loopback interface, and a
 * browser-attached Origin must be loopback too. The Host check drops
 * DNS-rebinding pages (their Host is the attacker's domain, not loopback); the
 * card's same-origin fetches carry no Origin and pass on Host alone.
 */
function trustedRequest(req: IncomingMessage, allowedHosts: readonly string[]): boolean {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
  return requestIsTrusted({ headers: {
    ...req.headers.host === undefined ? {} : { host: req.headers.host },
    ...origin === undefined ? {} : { origin },
  } }, allowedHosts)
}

function modelBadges(catalog: WorkBuddyCatalog): readonly WorkBuddyWebModelBadge[] {
  const selectable = new Set(catalog.current().map(model => model.id))
  return catalog.all().map(model => {
    const rate = normalizeCredits(model.billing?.credits)
    return {
      id: model.id,
      name: model.name,
      ...model.billing?.free === true ? { free: true as const } : {},
      ...model.billing?.badges === undefined ? {} : { badges: model.billing.badges },
      ...rate === undefined ? {} : { credits: rate },
      ...model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
      selectable: selectable.has(model.id),
      enabled: !catalog.isDisabled(model.id),
    }
  })
}

/** Build one token-free region section and respect the active/inactive cache cadence. */
async function buildRegionStatus(
  options: WorkBuddyStatusRegionOptions,
  activeMinutes: number,
  inactiveMinutes: number,
  autoCheckin: boolean,
  checkinStates?: ReadonlyMap<string, { todayCheckedIn?: boolean; todayCredit?: number; streakDays?: number }>,
  growthStates?: ReadonlyMap<string, WorkBuddyGrowthStatus>,
  taskStates?: ReadonlyMap<string, { outstanding: number }>,
): Promise<WorkBuddyWebRegion> {
  const accountRows = await options.store.accounts()
  const snapshots = await options.store.refreshCreditSnapshots(
    credential => options.client.fetchCredits(credential),
    Math.max(1, activeMinutes) * 60_000,
    Math.max(1, inactiveMinutes) * 60_000,
  )
  const accounts: WorkBuddyWebAccount[] = accountRows.map(account => {
    const snapshot = snapshots.get(account.id)
    const checkin = checkinStates?.get(account.id)
    const growth = growthStates?.get(account.id)
    const tasks = taskStates?.get(account.id)
    return {
      id: account.id,
      ...account.nickname === undefined ? {} : { nickname: account.nickname },
      ...account.note === undefined ? {} : { note: account.note },
       ...account.domain === undefined ? {} : { domain: account.domain },
      source: account.source,
      expiresAt: account.expiresAtMs,
      selected: account.selected,
      checkinEnabled: account.checkinEnabled,
      ...checkin === undefined ? {} : { checkin },
      ...growth === undefined ? {} : { growth },
      ...tasks === undefined ? {} : { tasks },
      ...snapshot?.credits === undefined ? {} : { credits: snapshot.credits },
      ...snapshot?.error === undefined ? {} : { creditsError: safeMessage(snapshot.error) },
    }
  })
  const selectedAccountId = options.store.selectedId()
  return {
    region: options.region,
    signedIn: accounts.length > 0,
    ...selectedAccountId === undefined ? {} : { selectedAccountId },
    accounts,
    ...options.catalog.all().length === 0 ? {} : { models: modelBadges(options.catalog) },
    scope: options.catalog.currentScope(),
    freeIds: options.catalog.freeIds(),
    priceSource: options.catalog.usesUpstreamPricing() ? 'upstream' : options.catalog.product().source,
    ...options.catalog.product().path === undefined ? {} : { priceSourcePath: options.catalog.product().path },
    ...options.catalog.product().endpoint === undefined ? {} : { endpoint: options.catalog.product().endpoint },
    ...options.probe === undefined ? {} : { probe: options.probe() },
    checkin: {
      supported: options.region === 'cn',
      enabled: options.region === 'cn' && autoCheckin,
    },
  }
}

/**
 * Assemble the card's status document. Sign-in state is read-only; credit is a
 * live billing answer whose failure degrades to `creditsError` rather than
 * failing the whole document.
 */
export async function workBuddyAiWebStatus(
  deps: WorkBuddyStatusRouteOptions,
): Promise<WorkBuddyWebStatus> {
  const policy = deps.refreshPolicy?.() ?? { activeMinutes: 15, inactiveMinutes: 60 }
  const regionStatuses: WorkBuddyWebRegion[] = []
  for (const region of ['global', 'cn'] as const) {
    const options = deps.regions?.[region]
    if (options === undefined) continue
    regionStatuses.push(await buildRegionStatus(options, policy.activeMinutes, policy.inactiveMinutes, deps.autoCheckin?.() ?? false, deps.checkinStates, deps.growthStates, deps.taskStates))
  }
  const authStatus = await deps.store.status()
  const hasRegionSignIn = regionStatuses.some(region => region.signedIn)
  if (authStatus.state !== 'signed-in' && !hasRegionSignIn) {
    return {
      status: 'signed-out',
      ...regionStatuses.length === 0 ? {} : { regions: regionStatuses },
      ...deps.controlKey === undefined ? {} : { controlKey: deps.controlKey },
    }
  }
  const selectedAuth = authStatus.state === 'signed-in' ? authStatus : undefined

  const catalog = deps.catalog
  const product = catalog.product()
  const freeIds = catalog.freeIds()
  const free = new Set(freeIds)
  const selectable = new Set(catalog.current().map(model => model.id))

  // The card receives *every* model the product configuration knows about, not
  // just the free ones: context capacity and price are exactly the facts a user
  // wants before deciding whether to lift the free-only filter, and the models
  // where that matters most are the paid ones.
  const modelsField: readonly WorkBuddyWebModelBadge[] = product.models
    .map(row => {
      const rate = normalizeCredits(row.credits)
      const isFree = free.has(row.id)
      return {
        id: row.id,
        name: row.name,
        ...isFree ? { free: true as const } : {},
        ...rate === undefined ? {} : { credits: rate },
        ...row.contextWindow > 0 ? { contextWindow: row.contextWindow } : {},
        selectable: selectable.has(row.id),
        enabled: !catalog.isDisabled(row.id),
      }
    })

  const status: WorkBuddyWebStatus = {
    status: 'signed-in',
    ...selectedAuth?.nickname === undefined ? {} : { nickname: selectedAuth.nickname },
    ...selectedAuth?.domain === undefined || selectedAuth.domain === '' ? {} : { domain: selectedAuth.domain },
    ...selectedAuth?.source === undefined ? {} : { source: selectedAuth.source },
    ...selectedAuth?.expiresAtMs === undefined ? {} : { expiresAt: selectedAuth.expiresAtMs },
    ...modelsField.length === 0 ? {} : { models: modelsField },
    scope: catalog.currentScope(),
    freeIds,
    priceSource: product.source,
    ...product.path === undefined ? {} : { priceSourcePath: product.path },
    ...product.endpoint === undefined ? {} : { endpoint: product.endpoint },
    ...regionStatuses.length === 0 ? {} : { regions: regionStatuses },
    refreshPolicy: policy,
    autoCheckin: deps.autoCheckin?.() ?? false,
    // Probe state rides the signed-in document so the card can render the
    // consent switch and results without a second request. The control key
    // travels with it: this response already passed the loopback guard, and the
    // key authorizes only control writes, never credentials or completions.
    ...deps.probe === undefined ? {} : { probe: deps.probe() },
    ...deps.controlKey === undefined ? {} : { controlKey: deps.controlKey },
  }

  try {
    const global = deps.regions?.global
    if (global !== undefined) {
      const selectedId = global.store.selectedId()
      const cached = selectedId === undefined ? undefined : global.store.creditSnapshot(selectedId)
      if (cached?.credits !== undefined) return { ...status, credits: cached.credits }
    }
    const credential = await deps.store.current()
    if (credential !== undefined) {
      const credits = await deps.client.fetchCredits(credential)
      return { ...status, credits }
    }
  } catch (error: unknown) {
    return { ...status, creditsError: safeMessage(error) }
  }
  return status
}

/** The status route's request handler, extracted so tests can mount it on a bare server. */
export function workBuddyAiStatusHandler(
  deps: WorkBuddyStatusRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!trustedRequest(req, deps.allowedHosts?.() ?? [])) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      json(res, 200, await workBuddyAiWebStatus(deps))
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** Mount the GET status route on an optional webServer context. */
export function registerWorkBuddyStatusRoute(ctx: Context, deps: WorkBuddyStatusRouteOptions): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_STATUS_PATH,
      handler: workBuddyAiStatusHandler(deps),
    })
    return () => {
      dispose()
    }
  }, 'dsh-workbuddy: Web status route')
}
