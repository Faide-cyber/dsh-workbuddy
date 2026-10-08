/**
 * WorkBuddy (international) models for DeepSeek Harness.
 *
 * Sign-in is browser OAuth (official CLI login) saved under `$DSH_HOME`, or the
 * WorkBuddy international desktop app's auth file as a fallback.
 *
 * Registers the `workbuddy-ai` provider; streaming, tool calls, compaction, and
 * permissions stay Harness-owned. The plugin exists because the overseas
 * deployment differs from the domestic one in three ways that a
 * domestically-configured route cannot absorb:
 *
 * 1. It signs in against `www.workbuddy.ai` (browser OAuth, or `workbuddy-desktop-ai.info`).
 * 2. Its personal model catalog lives at `/v2/enterprises/...` — the domestic
 *    `/console/...` path answers HTTP 500 there.
 * 3. Two of its free models are absent from that catalog entirely and must be
 *    added from the app's product configuration.
 *
 * @module dsh-workbuddy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import { WorkBuddyAccountStore, type WorkBuddyCredential } from './auth.ts'
import { WorkBuddyCatalog, type WorkBuddyModelScope } from './catalog.ts'
import { applyModelSwitchWrite } from './model-switches.ts'
import { createWorkBuddyAdapter, WORKBUDDY_CN_DISPLAY_NAME, WORKBUDDY_CN_PROVIDER, WORKBUDDY_DISPLAY_NAME, WORKBUDDY_PROVIDER } from './adapter.ts'
import { createWorkBuddyShim } from './shim.ts'
import { WorkBuddyProbeService } from './probe-service.ts'
import { newestFirst, WorkBuddyProbeStore } from './probe-store.ts'
import { acceptGrowthTasks, claimGrowthTask, fetchGrowthRewardToday, fetchGrowthStatus, fetchGrowthTasks, reportGrowthEvents, runGrowthTrip, WorkBuddyUpstreamClient, type WorkBuddyGrowthStatus, type WorkBuddyGrowthTask } from './upstream.ts'
import { buildGrowthEvent, GROWTH_NIGHT_KINDS, growthTaskSpec, inGrowthNightWindow, isSkippedGrowthTask } from './growth-tasks.ts'
import { loadProductConfig } from './product-config.ts'
import { registerWorkBuddyStatusRoute } from './web-status.ts'
import { createControlKey, registerWorkBuddyControlRoute } from './control-route.ts'
import { WorkBuddyOAuthLogin } from './oauth.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyWebProbeSection } from './status-paths.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'
import { readWorkBuddySettings, sanitizeSavedConfig, writeWorkBuddySettings } from './settings-file.ts'
import { WORKBUDDY_VERSION } from './version.ts'

export {
  WORKBUDDY_PROVIDER,
  WORKBUDDY_CN_PROVIDER,
  WORKBUDDY_DISPLAY_NAME,
  WORKBUDDY_CN_DISPLAY_NAME,
  createWorkBuddyAdapter,
  reasoningFields,
  type WorkBuddyAdapter,
} from './adapter.ts'
export { createWorkBuddyShim, type WorkBuddyShim } from './shim.ts'
export {
  composeCatalog,
  FALLBACK_WORKBUDDY_MODELS,
  WorkBuddyCatalog,
  type WorkBuddyModelInfo,
  type WorkBuddyModelScope,
} from './catalog.ts'
export {
  BUILTIN_CREDITS,
  BUILTIN_FREE_MODELS,
  FALLBACK_EXTRA_MODELS,
  FALLBACK_FREE_MODEL_IDS,
  freeModelIds,
  loadProductConfig,
  parseProductConfig,
  workBuddyProductConfigPath,
  type WorkBuddyProductConfig,
  type WorkBuddyProductModel,
} from './product-config.ts'
export {
  fingerprintModel,
  WorkBuddyProbeStore,
  workBuddyProbePath,
  WORKBUDDY_PROBE_FILENAME,
  type WorkBuddyProbeRecord,
  type WorkBuddyProbeValidation,
} from './probe-store.ts'
export {
  PROBE_EFFORT_CANDIDATES,
  randomSentinel,
  probeModel,
  type ProbeAttempt,
  type ProbeOutcome,
  type ProbeSender,
} from './probe.ts'
export { WorkBuddyProbeService, type WorkBuddyProbeStatus } from './probe-service.ts'
export { WorkBuddyOAuthLogin, LOGIN_TIMEOUT_MS } from './oauth.ts'
export {
  defaultDesktopAuthCandidates,
  defaultDesktopAuthPath,
  parseWorkBuddyAuth,
  credentialFromPluginToken,
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_CN_AUTH_FILE_ENV,
  WORKBUDDY_AUTH_FILENAME,
  WORKBUDDY_CN_AUTH_FILENAME,
  WORKBUDDY_DESKTOP_AUTH_BASENAME,
  WORKBUDDY_CN_DESKTOP_AUTH_BASENAME,
  WorkBuddyCredentialStore,
  WorkBuddyAccountStore,
  type WorkBuddyCredentialStoreLike,
  workBuddyOwnAuthPath,
  workBuddyRegionOwnAuthPath,
  type WorkBuddyAccountSummary,
  type WorkBuddyAuthStatus,
  type WorkBuddyCredential,
} from './auth.ts'
export {
  classifyUpstreamError,
  fetchGrowthRewardToday,
  fetchGrowthStatus,
  isFreeCredits,
  normalizeCredits,
  prepareChatBody,
  regionOf,
  runGrowthTrip,
  WorkBuddyUpstreamClient,
  type UpstreamErrorKind,
  type WorkBuddyChatResult,
  type WorkBuddyCredits,
  type WorkBuddyEffort,
  type WorkBuddyGrowthStatus,
  type WorkBuddyModelBilling,
  type WorkBuddyModelReasoning,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyRegion,
  type WorkBuddyUpstreamModel,
} from './upstream.ts'
export {
  WORKBUDDY_HOST_HEARTBEAT_FILENAME,
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  readHostHeartbeat,
  workBuddyHostHeartbeatPath,
  type WorkBuddyHostHeartbeat,
} from './host-heartbeat.ts'
export {
  WORKBUDDY_CONTROL_PATH,
  WORKBUDDY_STATUS_PATH,
  type WorkBuddyControlAction,
  type WorkBuddyWebAccount,
  type WorkBuddyWebCheckin,
  type WorkBuddyWebModelBadge,
  type WorkBuddyWebProbeModel,
  type WorkBuddyWebProbeSection,
  type WorkBuddyWebRegion,
  type WorkBuddyWebStatus,
} from './status-paths.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-workbuddy-ai'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/**
 * Settings namespace owning the configuration card.
 *
 * A namespace is a nominal string, validated by the type system where it is used
 * rather than at runtime. The cast is applied once here so the public constant
 * carries the seam's type without pulling the brand helper into this package.
 */
export const WORKBUDDY_SETTINGS_NS = 'workbuddy-ai' as SettingsNamespace

/** Plugin configuration. */
export interface Config {
  /** Explicit international WorkBuddy desktop auth-file path. */
  authFile?: string
  /** Explicit domestic WorkBuddy desktop auth-file path. */
  cnAuthFile?: string
  /** Active-account read-only refresh cadence in minutes. */
  refreshActiveMinutes?: number
  /** Inactive-account read-only refresh cadence in minutes. */
  refreshInactiveMinutes?: number
  /** Domestic daily check-in; off by default. */
  autoCheckin?: boolean
  /**
   * Whether the user has authorized sending probe requests about reasoning
   * efforts. Off by default: a probe spends real credit, so nothing is sent until
   * the user explicitly agrees.
   */
  probeConsent?: boolean
  /**
   * Which models the picker may show. `free` (the default) lists only models the
   * product configuration prices `x0.00`; `all` lifts the filter and makes paid
   * models selectable, so their credit cost becomes real.
   */
  modelScope?: WorkBuddyModelScope
  /** Domestic model scope, independent from the international card. */
  cnModelScope?: WorkBuddyModelScope
  /**
   * Model ids the picker must stop listing in the international card. Purely a
   * picker filter: an already-selected model keeps resolving and sending.
   */
  disabledModels?: string[]
  /** Same picker filter, for the domestic card. */
  cnDisabledModels?: string[]
  /**
   * Explicit product-configuration path, overriding the app's own cache
   * location. Only needed when the app keeps its state somewhere unusual.
   */
  productConfigFile?: string
  /**
   * Extra Host/Origin authorities for the settings card when DSH Web is
   * reached over LAN (e.g. `192.168.1.10`). Empty (the default) keeps the
   * card on loopback only. Never put LAN names into the loopback set.
   */
  allowedHosts?: string[]
}

export const Config: z<Config> = z.object({
  authFile: z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)'),
  cnAuthFile: z.string().description('Domestic WorkBuddy desktop auth file (defaults to the app\'s own location)'),
  refreshActiveMinutes: z.number().min(1).default(15)
    .description('Read-only refresh interval for the selected account'),
  refreshInactiveMinutes: z.number().min(1).default(60)
    .description('Read-only refresh interval for other accounts'),
  autoCheckin: z.boolean().default(false)
    .description('Automatically check in selected domestic accounts once per day'),
  probeConsent: z.boolean().default(false)
    .description('Authorize reasoning-effort probes (each probe sends real requests that may consume credit)'),
  modelScope: z.union([z.const('free'), z.const('all')]).default('free')
    .description('Which international models to offer: free only (default), or every model including paid ones'),
  cnModelScope: z.union([z.const('free'), z.const('all')]).default('free')
     .description('Which domestic models to offer: free only (default), or every model including paid ones'),
  disabledModels: z.array(z.string()).default([])
    .description('International models the model picker should not list (already-selected models keep working)'),
  cnDisabledModels: z.array(z.string()).default([])
    .description('Domestic models the model picker should not list (already-selected models keep working)'),
   productConfigFile: z.string()
    .description('Product configuration supplying model prices (defaults to the app\'s own cache)'),
  allowedHosts: z.array(z.string()).default([])
    .description('Extra Host names for the plugin card when DSH Web is opened over LAN (empty = loopback only)'),
})

/**
 * Start the loopback endpoint, register the `workbuddy-ai` provider, and refresh
 * the model catalog from the upstream once credentials allow it. The static
 * fallback catalog serves from the first moment, so an offline upstream never
 * leaves the provider empty.
 */
export function apply(ctx: Context, config: Config): void {
  const client = new WorkBuddyUpstreamClient()
  const store = new WorkBuddyAccountStore({
    region: 'global',
    ...config.authFile === undefined ? {} : { desktopPath: config.authFile },
    refresh: credential => client.refreshToken(credential),
  })
  const cnStore = new WorkBuddyAccountStore({
    region: 'cn',
    ...config.cnAuthFile === undefined ? {} : { desktopPath: config.cnAuthFile },
    refresh: credential => client.refreshToken(credential),
  })
  const oauth = new WorkBuddyOAuthLogin(client, undefined, 'global')
  const cnOauth = new WorkBuddyOAuthLogin(client, undefined, 'cn')

  // Prices and the omitted-model rows come from the app's product configuration,
  // resolved once at startup: it is a cache the app rewrites on its own schedule,
  // and a mid-session change would silently alter what the picker offers.
  const productConfig = loadProductConfig(
    config.productConfigFile !== undefined && config.productConfigFile.trim() !== ''
      ? config.productConfigFile.trim()
      : undefined,
  )
  // Live configuration source: the composed config, replaced by the settings
  // section's source once one is installed. `saved` is the card-driven layer on
  // top of it, backed by this plugin's own file — see `settings-file.ts` for
  // why the settings service is not trusted as the write path here.
  let base = (): Config => config
  const saved: Partial<Config> = sanitizeSavedConfig(readWorkBuddySettings())
  const current = (): Config => ({ ...base(), ...saved })

  const catalog = new WorkBuddyCatalog({
    productConfig,
    scope: current().modelScope ?? 'free',
  })
  const cnCatalog = new WorkBuddyCatalog({
    productConfig,
    scope: current().cnModelScope ?? current().modelScope ?? 'free',
    fallback: false,
     priceAuthority: 'upstream',
  })
  // Seeded from the card's own file, not just the composed config. A host whose
  // settings service has no `register()` never runs the inject callback below,
  // and nothing else would apply the file before the picker first asks: the
  // scope would sit at the composed default and the card would look reset.
  store.setDesktopPath(current().authFile)
  cnStore.setDesktopPath(current().cnAuthFile)
  catalog.setDisabled(current().disabledModels ?? [])
  cnCatalog.setDisabled(current().cnDisabledModels ?? [])
  const shim = createWorkBuddyShim({ store, client, catalog, logger: ctx.logger })
  const cnShim = createWorkBuddyShim({ store: cnStore, client, catalog: cnCatalog, logger: ctx.logger })
  /**
   * Apply a card-driven config edit: in memory first, so the switch moves, then
   * to the file. A write failure propagates — the card renders it, and a silent
   * no-op is exactly what made the switch look broken.
   */
  const persistConfigPatch = (patch: Partial<Config>): void => {
    Object.assign(saved, patch)
    writeWorkBuddySettings(saved)
  }
  const refreshPolicy = (): { activeMinutes: number; inactiveMinutes: number } => ({
    activeMinutes: Math.max(1, current().refreshActiveMinutes ?? 15),
    inactiveMinutes: Math.max(1, current().refreshInactiveMinutes ?? 60),
  })
  const autoCheckin = (): boolean => current().autoCheckin === true
  const refreshCredits = async (): Promise<void> => {
    const policy = refreshPolicy()
    const fetch = (credential: Parameters<typeof client.fetchCredits>[0]) => client.fetchCredits(credential)
    await Promise.all([
      store.refreshCreditSnapshots(fetch, policy.activeMinutes * 60_000, policy.inactiveMinutes * 60_000),
      cnStore.refreshCreditSnapshots(fetch, policy.activeMinutes * 60_000, policy.inactiveMinutes * 60_000),
    ])
  }

  // Probe state and the serial runner. Nothing here performs a request by
  // itself: `consent()` is consulted before every sweep, and the config default
  // is off, so an install that never opts in behaves exactly as before.
  const probeStore = new WorkBuddyProbeStore({ pluginVersion: WORKBUDDY_VERSION })
  const probeService = new WorkBuddyProbeService({
    store: probeStore,
    catalog,
    credentials: store,
    client,
    consent: () => current().probeConsent === true,
  })

  /**
   * Whether a model can be probed by hand: it reasons and the upstream declares
   * no effort set for it.
   *
   * Deliberately *not* filtered by whether a result already exists. Dropping a
   * model once it has been detected made the list shrink with use, so
   * re-detecting one model meant clearing every other result first. The list
   * stays stable and the card marks which entries already have an answer.
   */
  const isProbeCandidate = (info: WorkBuddyModelInfo): boolean => {
    if (info.reasoning?.supports !== true) return false
    return (info.reasoning.supportedEfforts?.length ?? 0) === 0
  }

  /** Compact probe state for the card: consent, candidates, observations. */
  const probeSection = (): WorkBuddyWebProbeSection => {
    const models = catalog.current()
    // Read results through the *same* judgement the adapter uses, rather than
    // straight from the store. A raw record can be stale in ways the adapter
    // already discounts — its catalog row changed, it aged past the TTL, or the
    // upstream has since declared an effort set (which always wins) — and showing
    // one would have the card promise levels the model picker does not offer.
    const results = models.flatMap(info => {
      const record = probeService.recordFor(info.id)
      if (record === undefined) return []
      return [{
        id: info.id,
        name: info.name,
        validation: record.validation,
        efforts: record.efforts,
        probedAt: record.probedAtMs,
      }]
    })
    return {
      consent: current().probeConsent === true,
      running: probeService.isRunning(),
      candidates: models.filter(isProbeCandidate).map(info => info.id),
      results: newestFirst(results),
    }
  }

  // Same-origin routes backing the Plugin-configuration card; the webServer
  // service is optional (a headless profile serves no browser).
  const controlKey = createControlKey()
  let refreshModels = () => {}
  /** Latest check-in read per account, so the card can show today's credit. */
  const checkinStates = new Map<string, { todayCheckedIn?: boolean; todayCredit?: number; streakDays?: number }>()
  /** Growth-plan state per account, plus today's payout when one landed. */
  const growthStates = new Map<string, WorkBuddyGrowthStatus & { claimedToday?: number }>()
  /** Accounts already dispatched or claimed today; the upstream limit is the real guard. */
  const lastGrowthDate = new Map<string, string>()
  /** Growth tasks still unclaimed per account, from the last sweep. */
  const taskStates = new Map<string, { outstanding: number }>()
  /** Accounts whose whole day is finished, keyed by account id -> date. */
  const autoCheckinDone = new Map<string, string>()
  const today = (): string => new Date().toLocaleDateString('en-CA')

  const delay = async (ms: number): Promise<void> => {
    await new Promise<void>(resolve => { setTimeout(resolve, ms) })
  }
  /**
   * Spacing between reported events. The upstream settles a report asynchronously
   * and quietly drops the ones that arrive too fast, so this is a correctness
   * knob, not politeness — lowering it makes tasks silently stop completing.
   */
  const GROWTH_REPORT_GAP_MS = 1_500
  /** Time allowed for a report burst (or an accept) to move the counters. */
  const GROWTH_SETTLE_MS = 1_500
  /** How long the button waits for the task sweep before answering anyway. */
  const CHECKIN_SWEEP_WAIT_MS = 4_000

  const storeFor = (region: 'cn' | 'global'): WorkBuddyAccountStore => region === 'cn' ? cnStore : store
  const oauthFor = (region: 'cn' | 'global'): WorkBuddyOAuthLogin => region === 'cn' ? cnOauth : oauth
  const catalogFor = (region: 'cn' | 'global'): WorkBuddyCatalog => region === 'cn' ? cnCatalog : catalog
  const safeReason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 300)

  const doCheckin = async (accountId: string): Promise<{ state: string; reason?: string }> => {
    try {
      const credential = await cnStore.resolveFor(accountId)
      const status = await client.fetchCheckinStatus(credential)
      checkinStates.set(accountId, status)
      if (status.todayCheckedIn) return { state: 'already-checked-in' }
      await client.claimDailyCheckin(credential)
      // Re-read rather than assume the amount: a streak day pays a bonus and
      // the card shows what actually landed.
      try {
        checkinStates.set(accountId, await client.fetchCheckinStatus(credential))
      } catch {
        // The reward is claimed either way; a failed re-read only costs precision.
      }
      return { state: 'checked-in' }
    } catch (error: unknown) {
      return { state: 'error', reason: safeReason(error) }
    }
  }

  /**
   * Read the buddy's state together with today's payout.
   *
   * Two calls, because `/status` reports `reward_credit: 0` once the buddy is
   * idle and the card would then say "今日旅行已完成" while hiding the credits.
   * The `/records` read is best-effort: a failure there still leaves a usable
   * state line, just without the amount.
   */
  const readGrowth = async (credential: WorkBuddyCredential): Promise<WorkBuddyGrowthStatus & { claimedToday?: number }> => {
    const growth = await fetchGrowthStatus(credential)
    try {
      const claimedToday = await fetchGrowthRewardToday(credential, today())
      return claimedToday === undefined ? growth : { ...growth, claimedToday }
    } catch {
      return growth
    }
  }

  /**
   * One growth-plan trip per account: claim what has arrived, otherwise send the
   * buddy out. Idempotent — the upstream daily limit is the real guard, this
   * only avoids re-reading the status on every 5-minute tick.
   */
  const runGrowth = async (accountId: string): Promise<{ dispatched: boolean; claimed?: number; reason?: string }> => {
    try {
      const credential = await cnStore.resolveFor(accountId)
      const result = await runGrowthTrip(credential)
      if (result.dispatched || result.claimed !== undefined) {
        lastGrowthDate.set(accountId, today())
        // Credits just landed: the cached totals are stale by definition.
        void refreshCredits()
      }
      // Re-read instead of leaving the card on the five-minute-old state: after a
      // manual check-in the buddy has just moved, and the card reloads the moment
      // this returns. A failed re-read keeps the previous state, which is the
      // honest answer when the read itself did not work.
      try {
        growthStates.set(accountId, await readGrowth(credential))
      } catch {
        // The trip result above is the real outcome; this only refreshes the label.
      }
      return result
    } catch (error: unknown) {
      return { dispatched: false, reason: safeReason(error) }
    }
  }

  /**
   * Light up and collect every growth-center task for one account.
   *
   * The upstream moves a task only when activity events are reported, so
   * "earning" a task means: accept it, post the missing number of events, then
   * claim it. The whole sweep is deliberately sequential and spaced out —
   * reports sent faster than the upstream settles are accepted and counted
   * nowhere, which looks exactly like success and is the failure this guards
   * against.
   *
   * Never throws: a per-task failure is recorded and the sweep moves on, because
   * one unclaimable task must not cost the user the credits from the others.
   */
  const runGrowthTasks = async (
    accountId: string,
    credential: WorkBuddyCredential,
  ): Promise<{ claimed: number; outstanding: number; reason?: string }> => {
    const uid = credential.uid
    let tasks: WorkBuddyGrowthTask[]
    try {
      tasks = await fetchGrowthTasks(credential)
    } catch (error: unknown) {
      return { claimed: 0, outstanding: 0, reason: safeReason(error) }
    }
    // An empty list is a failed read, not "nothing to do": answering the latter
    // would let the account settle into "done for today" with nothing collected.
    if (tasks.length === 0) return { claimed: 0, outstanding: 0, reason: 'growth task list is empty' }

    const unaccepted = tasks
      .filter(task => task.status === 'not_accepted' && !isSkippedGrowthTask(task.code))
      .map(task => task.code)
    if (unaccepted.length > 0) {
      try {
        await acceptGrowthTasks(credential, unaccepted)
        // Progress bars only appear once a task is accepted; without this second
        // read the target is unknown and the sweep would report nothing.
        await delay(GROWTH_SETTLE_MS)
        tasks = await fetchGrowthTasks(credential)
      } catch {
        // Accepting failed: fall through with the old list, which at worst means
        // the tasks stay unaccepted and the next sweep retries.
      }
    }

    let claimed = 0
    let outstanding = 0
    for (const task of tasks) {
      if (isSkippedGrowthTask(task.code) || task.status === 'claimed') continue
      const spec = growthTaskSpec(task.code)
      if (spec === undefined) continue
      // A task the upstream pays nothing for (black_cat currently) is not worth
      // a sweep slot: our reports for it never counted, so it would sit here
      // as permanently outstanding and keep the button live forever.
      if (task.rewardCredit <= 0) continue
      if (GROWTH_NIGHT_KINDS.has(spec.kind) && !inGrowthNightWindow()) {
        // Sending outside the window is accepted and ignored; retry after 23:00.
        outstanding += 1
        continue
      }
      outstanding += 1

      const need = Math.max(0, task.target - task.current)
      // Start the id counter at the progress already banked: the upstream dedups
      // by event id, so reusing an id that already counted would be dropped and
      // a retried sweep would spin on the same reports forever.
      for (let index = task.current; index < task.target; index += 1) {
        try {
          await reportGrowthEvents(credential, [buildGrowthEvent(uid, spec.kind, index)])
        } catch {
          break
        }
        if (index + 1 < task.target) await delay(GROWTH_REPORT_GAP_MS)
      }
      if (need > 0) await delay(GROWTH_SETTLE_MS)

      // A single unclaimable task must not abort the sweep: the others can
      // still pay out, and the next tick retries this one.
      try {
        const result = await claimGrowthTask(credential, task.code)
        if (result.ok) {
          outstanding -= 1
          if (result.credit !== undefined) claimed += result.credit
        }
      } catch {
        // Transport failure on the claim; left outstanding for the next sweep.
      }
      // A refused claim stays outstanding on purpose: it usually means the
      // upstream has not settled yet, and the next sweep picks it up.
    }

    if (claimed > 0) void refreshCredits()
    taskStates.set(accountId, { outstanding })
    return { claimed, outstanding }
  }

  /**
   * Run one task sweep at a time per account.
   *
   * The sweep takes tens of seconds by design (spaced reports), and both the
   * button and the five-minute timer can ask for it. Overlapping sweeps would
   * double-report events and race the claim, so the second caller joins the
   * first rather than starting its own.
   */
  const growthTaskRuns = new Map<string, Promise<{ claimed: number; outstanding: number; reason?: string }>>()
  const sweepGrowthTasks = (accountId: string): Promise<{ claimed: number; outstanding: number; reason?: string }> => {
    const running = growthTaskRuns.get(accountId)
    if (running !== undefined) return running
    const run = (async () => {
      try {
        const credential = await cnStore.resolveFor(accountId)
        return await runGrowthTasks(accountId, credential)
      } catch (error: unknown) {
        return { claimed: 0, outstanding: 0, reason: safeReason(error) }
      } finally {
        growthTaskRuns.delete(accountId)
      }
    })()
    growthTaskRuns.set(accountId, run)
    return run
  }

  /** True once today's check-in is in and the buddy has nothing left to do. */
  const growthFinished = (growth: WorkBuddyGrowthStatus | undefined): boolean =>
    growth !== undefined && growth.state === 'idle' && growth.dailyLimitReached === true

  /**
   * The card's one button: everything today's credits are owed for.
   *
   * The check-in and the trip are awaited because they answer fast and their
   * outcome is what the card reports back. The task sweep is not: filling five
   * progress bars takes tens of seconds of spaced reports, and holding an HTTP
   * response open for that is how a click turns into a timeout. It runs on the
   * side and the card's poll picks the result up.
   */
  const checkinAndGrow = async (accountId: string): Promise<{ state: string; reason?: string; claimed?: number }> => {
    const result = await doCheckin(accountId)
    const growth = await runGrowth(accountId)
    let total = growth.claimed ?? 0
    const swept = await Promise.race([
      sweepGrowthTasks(accountId),
      delay(CHECKIN_SWEEP_WAIT_MS).then(() => undefined),
    ])
    if (swept !== undefined) total += swept.claimed
    return total > 0 ? { ...result, claimed: total } : result
  }

  /**
   * Read-only poll so the card can show today's credit and trip state even when
   * auto check-in is off. Two GETs per account every five minutes is cheap; running this
   * unconditionally is what makes "今日尚未获得积分" correct instead of blank.
   */
  const refreshCheckinStates = async (): Promise<void> => {
    for (const account of await cnStore.accounts()) {
      try {
        const credential = await cnStore.resolveFor(account.id)
        checkinStates.set(account.id, await client.fetchCheckinStatus(credential))
      } catch {
        // An unreachable account simply keeps its last known state on the card.
      }
      try {
        const credential = await cnStore.resolveFor(account.id)
        growthStates.set(account.id, await readGrowth(credential))
      } catch {
        // The growth plan is optional; a failure must not blank the check-in state.
      }
    }
  }

  /**
   * The daily sweep behind "自动签到".
   *
   * Runs every tick and decides per account, rather than once per day for all of
   * them: the buddy comes back *hours* after the click that sent it out, and a
   * once-a-day guard would leave that credit uncollected until tomorrow — which
   * is exactly the bug this replaces. An account is marked finished only once
   * its check-in landed, the buddy is home for the day, and every task has been
   * accepted and claimed, so an unfinished day keeps retrying.
   *
   * ponytail: an account whose tasks never move (a code the upstream no longer
   * credits, say) is retried on every five-minute tick. Each retry is a few
   * cheap GETs, so this is left alone; add a per-account sweep cap per day if
   * the upstream starts metering read traffic.
   */
  const runAutoCheckin = async (): Promise<void> => {
    if (!autoCheckin()) return
    const day = today()
    for (const account of await cnStore.accounts()) {
      if (!account.checkinEnabled) continue
      if (autoCheckinDone.get(account.id) === day) continue
      await doCheckin(account.id)
      await runGrowth(account.id)
      const swept = await sweepGrowthTasks(account.id)
      if (
        checkinStates.get(account.id)?.todayCheckedIn === true
        && growthFinished(growthStates.get(account.id))
        && swept.outstanding === 0
        && swept.reason === undefined
      ) {
        autoCheckinDone.set(account.id, day)
      }
    }
  }

  ctx.inject(['webServer'], webCtx => {
    registerWorkBuddyStatusRoute(webCtx, {
      store,
      client,
      catalog,
      regions: {
        global: { region: 'global', store, client, catalog, probe: () => probeSection() },
        cn: { region: 'cn', store: cnStore, client, catalog: cnCatalog },
      },
      refreshPolicy,
      autoCheckin,
      probe: () => probeSection(),
      controlKey,
      allowedHosts: () => current().allowedHosts ?? [],
      checkinStates,
      growthStates,
      taskStates,
    })
    // One write for a whole selection: select-all must not rewrite the settings
    // file once per row.
    const applyModelSwitches = (models: readonly string[], enabled: boolean, region?: 'cn' | 'global'): Promise<void> =>
      applyModelSwitchWrite(
        catalogFor(region ?? 'global'),
        models,
        enabled,
        ids => persistConfigPatch(region === 'cn' ? { cnDisabledModels: [...ids] } : { disabledModels: [...ids] }),
        refreshModels,
      )
    registerWorkBuddyControlRoute(webCtx, {
      probe: async modelId => {
        // The authenticated manual endpoint is called only after per-model confirmation.
        const result = await probeService.probe(modelId, true)
        if (result.state === 'ok') refreshModels()
        return result
      },
      clearProbe: () => {
        probeStore.clear()
        refreshModels()
      },
      setScope: (scope, region) => {
        // regional scope is applied below
        const target = region === undefined ? catalog : catalogFor(region)
        target.setScope(scope)
        persistConfigPatch(region === 'cn' ? { cnModelScope: scope } : { modelScope: scope })
        refreshModels()
      },
      loginStart: async region => oauthFor(region ?? 'global').start(),
      loginPoll: async region => {
        const actual = region ?? 'global'
        const login = oauthFor(actual)
        const target = storeFor(actual)
        const targetCatalog = catalogFor(actual)
        const result = await login.poll()
        if ('pending' in result) return { pending: true as const }
        await target.importCredential(result.auth)
        try {
          targetCatalog.setUpstream(await client.fetchModels(result.auth))
        } catch {
          // Static fallback catalog remains until the next successful fetch.
        }
        refreshModels()
        void refreshCredits()
        if (actual === 'cn') {
          // A freshly signed-in account has no finished day recorded; clearing the
          // guard is what makes the sweep run for it immediately.
          autoCheckinDone.clear()
          await runAutoCheckin()
        }
        return { done: true as const }
      },
      logout: async region => {
        const actual = region ?? 'global'
        oauthFor(actual).cancel()
        await storeFor(actual).logout()
        refreshModels()
      },
      selectAccount: async (region, accountId) => {
        await storeFor(region).select(accountId)
        try {
          const credential = await storeFor(region).resolveFor(accountId)
          catalogFor(region).setUpstream(await client.fetchModels(credential))
        } catch {
          // Account selection itself remains successful even when the catalog is offline.
        }
        refreshModels()
        void refreshCredits()
      },
      removeAccount: async (region, accountId) => {
        const target = storeFor(region)
        await target.removeAccount(accountId)
        try {
          const credential = await target.resolve()
          catalogFor(region).setUpstream(await client.fetchModels(credential))
        } catch {
          // Removing an account remains successful even when the replacement catalog is offline.
        }
        refreshModels()
        void refreshCredits()
      },
      setAccountNote: async (region, accountId, note) => {
         return await storeFor(region).setNote(accountId, note)
       },
       setCheckinEnabled: async (accountId, enabled) => {
        await cnStore.setCheckinEnabled(accountId, enabled)
        if (enabled) {
          void refreshCredits()
          // Turning the switch on is a request to run now, even if the account was
          // already marked finished today (it may have been finished while off).
          autoCheckinDone.delete(accountId)
          await runAutoCheckin()
        }
      },
      checkin: checkinAndGrow,
      setRefreshPolicy: async (activeMinutes, inactiveMinutes) => {
        await persistConfigPatch({ refreshActiveMinutes: activeMinutes, refreshInactiveMinutes: inactiveMinutes })
      },
      setAutoCheckin: async enabled => {
        await persistConfigPatch({ autoCheckin: enabled })
        if (!enabled) return
        autoCheckinDone.clear()
        void runAutoCheckin()
      },
      setModelEnabled: async (model, enabled, region) => {
        await applyModelSwitches([model], enabled, region)
      },
      setModelsEnabled: async (models, enabled, region) => {
        await applyModelSwitches(models, enabled, region)
      },
      connectivity: async (region, accountId) => {
        try {
          const target = storeFor(region)
          const credential = accountId === undefined ? await target.resolve() : await target.resolveFor(accountId)
          await client.testConnectivity(credential)
          return { state: 'ok' }
        } catch (error: unknown) {
          return { state: 'error', reason: safeReason(error) }
        }
      },
      allowedHosts: () => current().allowedHosts ?? [],
    }, controlKey)
  })

  // The settings section is what makes the provider visible on the Models
  // settings page (settings.describe joins the provider directory). It is a
  // read-through only: registration never completed in this profile, so card
  // edits are persisted by `settings-file.ts` instead. `saved` wins over the
  // section's value because a card edit is newer than the composed config.
  ctx.inject(['settings'], settingsCtx => {
    // The section is what makes the provider visible on the Models settings
    // page (settings.describe joins the provider directory). A host whose
    // settings service predates `register()` — dsh 0.1.7 derives namespaces
    // from a plugin Config schema instead — throws a TypeError here that
    // cordis swallows, so the guard keeps that from looking like a plugin
    // failure. The card's own file is the write path either way.
    const settings = settingsCtx.settings as typeof settingsCtx.settings & {
      register?: (ns: string, schema: unknown, options: { base: Config }) => {
        get: () => Config
        watch: (callback: () => void) => () => void
      }
    }
    if (typeof settings.register !== 'function') {
      ctx.logger.info('dsh-workbuddy: settings service has no register(); the card persists to its own file')
      return
    }
    const scope = settings.register(WORKBUDDY_SETTINGS_NS, Config, { base: config })
    base = () => scope.get()
    const apply = (): void => {
      const next = current()
      store.setDesktopPath(next.authFile)
      cnStore.setDesktopPath(next.cnAuthFile)
      catalog.setScope(next.modelScope ?? 'free')
      cnCatalog.setScope(next.cnModelScope ?? next.modelScope ?? 'free')
      catalog.setDisabled(next.disabledModels ?? [])
      cnCatalog.setDisabled(next.cnDisabledModels ?? [])
      refreshModels()
      void refreshCredits()
      void refreshCheckinStates()
      void runAutoCheckin()
    }
    apply()
    // A committed settings value supersedes the stored file, so an edit made in
    // the DSH settings page is what the card shows rather than a stale layer.
    ctx.effect(() => scope.watch(() => {
      // The section only fills in what the card has never written. `scope.get()`
      // always returns every schema field, defaults included, so merging it whole
      // would push `cnModelScope: 'free'` and an empty disabled list over a
      // file-backed selection and the next card edit would persist that reset.
      const fromSection = sanitizeSavedConfig(scope.get() as Record<string, unknown>)
      const filled = saved as Record<string, unknown>
      for (const [key, value] of Object.entries(fromSection)) if (!(key in filled)) filled[key] = value
      apply()
    }), 'dsh-workbuddy: settings observer')
  })

  let stopped = false
  const backgroundTimer = setInterval(() => {
    void refreshCredits()
    void runAutoCheckin()
    void refreshCheckinStates()
  }, 300_000)
  void refreshCredits()
  void refreshCheckinStates()
  void runAutoCheckin()
  ctx.effect(() => () => {
    stopped = true
    clearInterval(backgroundTimer)
    oauth.cancel()
    cnOauth.cancel()
    void shim.close()
    void cnShim.close()
    void clearHostHeartbeat()
  })

  void Promise.all([shim.ready, cnShim.ready])
    .then(() => {
      if (stopped) return

      let invalidateGlobal: (() => void) | undefined
      let invalidateCn: (() => void) | undefined
      try {
        // Constructed only once each listener holds a port; existing global model
        // profiles keep the same provider id and shim/store path.
        const globalAdapter = createWorkBuddyAdapter({
          shim,
          store,
          catalog,
          provider: WORKBUDDY_PROVIDER,
          displayName: WORKBUDDY_DISPLAY_NAME,
          resolveAttachments: () => ctx.get('attachments'),
          observe: modelId => probeService.recordFor(modelId),
        })
        const cnAdapter = createWorkBuddyAdapter({
          shim: cnShim,
          store: cnStore,
          catalog: cnCatalog,
          provider: WORKBUDDY_CN_PROVIDER,
          displayName: WORKBUDDY_CN_DISPLAY_NAME,
          resolveAttachments: () => ctx.get('attachments'),
        })
        invalidateGlobal = globalAdapter.invalidate
        invalidateCn = cnAdapter.invalidate
        refreshModels = () => {
          if (stopped) return
          invalidateGlobal?.()
          invalidateCn?.()
          ctx.emit('llm/adapters-updated')
        }

        const releases: Array<() => void> = []
        try {
          releases.push(ctx.llm.registerAdapter([WORKBUDDY_PROVIDER], globalAdapter.adapter))
          releases.push(ctx.llm.registerAdapter([WORKBUDDY_CN_PROVIDER], cnAdapter.adapter))
          releases.push(ctx.llm.registerConfigurableProviders([
            {
              provider: WORKBUDDY_PROVIDER,
              displayName: WORKBUDDY_DISPLAY_NAME,
              settingsNs: WORKBUDDY_SETTINGS_NS,
              settingsPath: [],
              declared: false,
            },
            {
              provider: WORKBUDDY_CN_PROVIDER,
              displayName: WORKBUDDY_CN_DISPLAY_NAME,
              settingsNs: WORKBUDDY_SETTINGS_NS,
              settingsPath: [],
              declared: false,
            },
          ]))
        } catch (error: unknown) {
          for (const release of releases.reverse()) release()
          throw error
        }
        try {
          ctx.effect(() => () => {
            for (const release of releases.reverse()) release()
          })
        } catch {
          for (const release of releases.reverse()) release()
        }

        // The host bundle is live: write a heartbeat so the status CLI can report
        // host health without a browser. Cleared on disposal; a stale heartbeat
        // after a crash is detected by PID in the reader.
        void writeHostHeartbeat()
      } catch (error: unknown) {
        ctx.logger.error('dsh-workbuddy: provider registration failed', error)
        return
      }

      void (async () => {
        for (const [targetStore, targetClient, targetCatalog] of [
          [store, client, catalog],
          [cnStore, client, cnCatalog],
        ] as const) {
          try {
            const credential = await targetStore.current()
            if (credential === undefined || stopped) continue
            const models = await targetClient.fetchModels(credential)
            if (stopped) return
            targetCatalog.setUpstream(models)
          } catch (error: unknown) {
            ctx.logger.warn(
              'dsh-workbuddy: dynamic model catalog unavailable; serving the static fallback list',
              error,
            )
          }
        }
        invalidateGlobal?.()
        invalidateCn?.()
      })()
    })
    .catch((error: unknown) => {
      ctx.logger.error('dsh-workbuddy: loopback endpoint failed to start; provider not registered', error)
    })
}
