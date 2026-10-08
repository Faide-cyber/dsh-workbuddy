/**
 * Node-free constants and types shared by the Host and browser halves.
 *
 * @module dsh-workbuddy/status-paths
 */

/** Plugin-owned status endpoint consumed by its browser half. */
export const WORKBUDDY_STATUS_PATH = '/plugins/dsh-workbuddy/status'

/** Header carrying the per-process key on control requests. */
export const WORKBUDDY_CONTROL_KEY_HEADER = 'x-workbuddy-control-key'

/**
 * Plugin-owned control endpoint.
 *
 * Separate from the status route because it accepts writes: the status route's
 * loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
 * not the same as authorizing a state-changing action. This route therefore also
 * requires the in-process key the browser half receives with the status document.
 */
export const WORKBUDDY_CONTROL_PATH = '/plugins/dsh-workbuddy/control'

/** One model's recorded probe observation, as the card displays it. */
export interface WorkBuddyWebProbeModel {
  id: string
  name: string
  /** `validating` results carry efforts; the other states never do. */
  validation: 'validating' | 'non-validating' | 'unknown'
  efforts: readonly string[]
  probedAt: number
}

/** Probe section of the status document. */
export interface WorkBuddyWebProbeSection {
  /** Whether the user has authorized probing. */
  consent: boolean
  /** Whether a sweep is in flight right now. */
  running: boolean
  /** Models the user could probe by hand (undeclared yet reasoning-capable). */
  candidates: readonly string[]
  /** Recorded observations. */
  results: readonly WorkBuddyWebProbeModel[]
}

/** One billing package and its remaining credit. */
export interface WorkBuddyWebCreditAccount {
  packageName: string
  remain: number
  size: number
  /** Upstream `CapacityType`: 4 = monthly plan quota, 1 = granted bonus pack. */
  capacityType: number
  /** Epoch ms when the package expires; absent when the upstream reports none. */
  expiresAt?: number
}

/** Aggregated credit answer rendered by the plugin card. */
export interface WorkBuddyWebCredits {
  total: number
  accounts: readonly WorkBuddyWebCreditAccount[]
}

/** Billing convenience facts for one model, rendered as card badges. */
export interface WorkBuddyWebModelBadge {
  id: string
  name: string
  /** Whether the model is currently free (`x0.00` credits). */
  free?: boolean
  /** Promotional badges, e.g. `限时免费`, `夜间折扣`. */
  badges?: readonly string[]
  /** Credits multiplier in display form, e.g. `x0.79`. */
  credits?: string
  /** Context capacity in tokens, taken verbatim from the upstream catalog. */
  contextWindow?: number
  /**
   * Whether the free-only policy currently admits this model into the picker.
   * A card needs this to explain why a listed model is not selectable.
   */
  selectable?: boolean
  /**
   * Whether the per-model switch is on. `false` means the picker no longer
   * lists the model, though a session that already selected it keeps working.
   */
  enabled?: boolean
}

/**
 * Which models the picker is allowed to show.
 *
 * `free` is the default: only models the product configuration prices `x0.00`.
 * `all` lifts the filter and exposes every model the account can reach, which
 * means paid models become selectable and their credit cost is real.
 */
export type WorkBuddyModelScope = 'free' | 'all'

/** A token-free account row shown in the region tab. */
export interface WorkBuddyWebAccount {
  id: string
  nickname?: string
  note?: string
  domain?: string
  source?: 'desktop' | 'dsh'
  expiresAt?: number
  selected: boolean
  checkinEnabled?: boolean
  /** Today's check-in state for this account; absent when it was never read. */
  checkin?: { todayCheckedIn?: boolean; todayCredit?: number; streakDays?: number }
  /** Growth-plan ("小猫成长计划") state; absent when it was never read. */
  growth?: { state: string; dailyLimitReached?: boolean; rewardCredit?: number; arriveAt?: number; locationName?: string; claimedToday?: number }
  /** Growth-center tasks still unclaimed today; absent when no sweep has run. */
  tasks?: { outstanding: number }
  credits?: WorkBuddyWebCredits
  creditsError?: string
  connectivity?: { state: 'unknown' | 'checking' | 'ok' | 'error'; checkedAt?: number; message?: string }
}

export interface WorkBuddyWebCheckin {
  supported: boolean
  enabled: boolean
  active?: boolean
  todayCheckedIn?: boolean
  streakDays?: number
  dailyCredit?: number
  /** What today actually paid out, which differs from `dailyCredit` on a bonus day. */
  todayCredit?: number
  error?: string
}

export interface WorkBuddyWebRegion {
  region: 'cn' | 'global'
  signedIn: boolean
  selectedAccountId?: string
  accounts: readonly WorkBuddyWebAccount[]
  models?: readonly WorkBuddyWebModelBadge[]
  probe?: WorkBuddyWebProbeSection
  scope?: WorkBuddyModelScope
  freeIds?: readonly string[]
  priceSource?: 'cache' | 'builtin' | 'upstream'
  priceSourcePath?: string
  endpoint?: string
  checkin?: WorkBuddyWebCheckin
}

/** The JSON document the plugin card renders. */
export type WorkBuddyWebStatus =
  | { status: 'signed-out'; controlKey?: string; regions?: readonly WorkBuddyWebRegion[] }
  | {
    status: 'signed-in'
    nickname?: string
    domain?: string
    source?: 'desktop' | 'dsh'
    expiresAt?: number
    credits?: WorkBuddyWebCredits
    creditsError?: string
    /** Billing convenience facts for the models the plugin serves. */
    models?: readonly WorkBuddyWebModelBadge[]
    /** Reasoning-effort probe state, consent, and recorded observations. */
    probe?: WorkBuddyWebProbeSection
    /** The active billing policy. */
    scope?: WorkBuddyModelScope
    /** Model ids the product configuration prices free. */
    freeIds?: readonly string[]
    /** Where the price data came from, for the card's provenance line. */
    priceSource?: 'cache' | 'builtin' | 'upstream'
    /** Path of the product configuration when one was read. */
    priceSourcePath?: string
    /** Endpoint the product configuration points at, e.g. `https://www.workbuddy.ai`. */
    endpoint?: string
    /**
     * In-process key authorizing control writes. Handed to the card with the
     * status document (the card is same-origin and already had to pass the
     * loopback guard); it is never persisted and rotates per process.
     */
    controlKey?: string
    regions?: readonly WorkBuddyWebRegion[]
    refreshPolicy?: { activeMinutes: number; inactiveMinutes: number }
    autoCheckin?: boolean
  }
  | { status: 'error'; message: string }

/** Action requested from the control route. */
export type WorkBuddyControlAction =
  | { action: 'probe'; model: string }
  | { action: 'clearProbe' }
  | { action: 'setScope'; scope: WorkBuddyModelScope; region?: 'cn' | 'global' }
  | { action: 'loginStart'; region?: 'cn' | 'global' }
  | { action: 'loginPoll'; region?: 'cn' | 'global' }
  | { action: 'logout'; region?: 'cn' | 'global' }
  | { action: 'selectAccount'; region: 'cn' | 'global'; accountId: string }
  | { action: 'removeAccount'; region: 'cn' | 'global'; accountId: string }
  | { action: 'setAccountNote'; region: 'cn' | 'global'; accountId: string; note: string }
  | { action: 'setCheckinEnabled'; accountId: string; enabled: boolean }
  | { action: 'checkin'; accountId: string }
  | { action: 'connectivity'; region: 'cn' | 'global'; accountId?: string }
  | { action: 'setRefreshPolicy'; activeMinutes: number; inactiveMinutes: number }
  | { action: 'setAutoCheckin'; enabled: boolean }
  | { action: 'setModelEnabled'; model: string; enabled: boolean; region?: 'cn' | 'global' }
  | { action: 'setModelsEnabled'; models: readonly string[]; enabled: boolean; region?: 'cn' | 'global' }
