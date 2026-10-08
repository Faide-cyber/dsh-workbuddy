/**
 * WorkBuddy status and policy card, contributed to Harness Plugin
 * configuration.
 *
 * The card is the plugin's only interactive surface. It reports the account and
 * remaining credit, starts browser OAuth, and owns the two decisions a user
 * actually makes here: which models the picker may show (the free-only filter),
 * and whether reasoning effort may be probed.
 *
 * Every action goes through the host's control route, which re-validates the
 * loopback origin and the in-process key. The card holds no credential and
 * cannot reach the upstream directly.
 *
 * @module dsh-workbuddy/client/WorkBuddyPluginCard
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { EXPIRY_SOON_DAYS, checkinExhausted, classifyCheckin, daysUntilExpiry, formatCountdown, formatExpiry } from '../display.ts'
import { WORKBUDDY_CONTROL_KEY_HEADER, WORKBUDDY_CONTROL_PATH, WORKBUDDY_STATUS_PATH } from '../status-paths.ts'
import type { WorkBuddyModelScope, WorkBuddyWebAccount, WorkBuddyWebModelBadge, WorkBuddyWebRegion, WorkBuddyWebStatus } from '../status-paths.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface WorkBuddyPluginCardInjected {
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
  region?: 'cn' | 'global'
}

/**
 * Props delivered by the Plugin configuration item slot.
 *
 * The slot's owner share is empty (`children` is never supplied). The card
 * reads its copy from the injected `t` rather than from owner props, so the
 * type is only the injected face plus the usual React children prohibition.
 */
export type WorkBuddyPluginCardProps = Partial<WorkBuddyPluginCardInjected> & { region?: 'cn' | 'global' }

/** How often the card re-reads the status document while it is open. */
const POLL_INTERVAL_MS = 60_000
/** How often the card polls an in-flight browser login. */
const LOGIN_POLL_INTERVAL_MS = 2000

const cardStyle: CSSProperties = {
  overflow: 'hidden',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-module-platform)',
}
const headerStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  border: 0,
  padding: '13px 14px',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}
const headTextStyle: CSSProperties = { display: 'flex', minWidth: 0, flexDirection: 'column', gap: 3 }
const nameStyle: CSSProperties = { fontSize: 14, lineHeight: '20px', fontWeight: 600 }
const descriptionStyle: CSSProperties = { fontSize: 13, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const chevronStyle: CSSProperties = {
  flex: 'none',
  color: 'var(--dsw-alias-label-tertiary)',
  transition: 'transform 160ms ease',
}

/**
 * Official DSH settings-card chevron (`IconChevronDownOutline14`).
 *
 * Inlined so the plugin card does not depend on `dsh-client-ui-primitives`
 * being in the ModuleLoader table. The path is the same 14×14 glyph the
 * built-in PluginCard uses.
 */
function ChevronDownOutline14(props: { open: boolean }): ReactElement {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ ...chevronStyle, transform: props.open ? 'rotate(180deg)' : 'none' }}
    >
      <path
        d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z"
        fill="currentColor"
      />
    </svg>
  )
}
const cardBodyStyle: CSSProperties = { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '16px 14px 18px' }
const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
const statusStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
const buttonStyle: CSSProperties = { boxSizing: 'border-box', minHeight: 34, padding: '6px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14, cursor: 'pointer' }
/** The manual check-in sits inline beside 自动签到, so it is deliberately small. */
const checkinButtonStyle: CSSProperties = { ...buttonStyle, minHeight: 26, padding: '2px 10px', fontSize: 12, borderRadius: 13 }
/** Sits beside the model search field, so it matches that field's height exactly. */
const toolbarButtonStyle: CSSProperties = { ...buttonStyle, minHeight: 30, padding: '3px 12px', fontSize: 13, borderRadius: 6, whiteSpace: 'nowrap' }
const formControlStyle: CSSProperties = { accentColor: 'var(--dsw-alias-brand-primary, #4b8cff)', colorScheme: 'dark' }
const numberInputStyle: CSSProperties = { ...formControlStyle, boxSizing: 'border-box', width: 70, minHeight: 30, padding: '3px 8px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', appearance: 'textfield' }
const radioInputStyle: CSSProperties = { ...formControlStyle, flex: 'none', width: 18, height: 18, margin: '2px 0 0', border: '2px solid var(--dsw-alias-border-l2)', borderRadius: '50%', background: 'transparent', appearance: 'none', cursor: 'pointer' }
const accountItemStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, padding: 10, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)' }
/** The account in use answers "which one am I on?" with an outline, not a chip alone. */
const accountItemSelectedStyle: CSSProperties = { borderColor: 'var(--dsw-alias-brand-primary)', boxShadow: 'inset 0 0 0 1px var(--dsw-alias-brand-primary)' }
const accountMetaStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
/** A package inside the warning window. Tertiary weight first, not bright. */
const expiringSoonStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', fontWeight: 500, color: 'var(--dsw-alias-state-warn-primary, #d19100)' }
/** Last day or already gone. Loud enough to notice while scrolling the card. */
const expiringVerySoonStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', fontWeight: 600, color: 'var(--dsw-alias-state-error-primary)' }
const noteEditorStyle: CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }
const noteInputStyle: CSSProperties = { ...numberInputStyle, flex: '1 1 180px', width: 180, minWidth: 0 }
const connectivityStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }
/** Left half of the account's action row: the buddy line and today's credit, stacked. */
const accountTextStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: '1 1 auto' }
/** Right half: 立即签到 and 自动签到 share the text's baseline instead of owning a row. */
const accountActionsStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }
/** Holds the two halves; `flex-end` keeps the buttons in the card's bottom-right corner. */
const accountRowStyle: CSSProperties = { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', width: '100%' }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
const sectionStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 16 }
const sectionTitleStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const quotaGroupStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const quotaLabelStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
const modelRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 0' }
const modelBadgeStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
const modelRateStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const chipStyle: CSSProperties = {
  padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: '18px',
  background: 'var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))',
  color: 'var(--dsw-alias-state-success-primary, #22a06b)',
}
const mutedChipStyle: CSSProperties = {
  padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: '18px',
  background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06))',
  color: 'var(--dsw-alias-label-tertiary)',
}
const progressTrackStyle: CSSProperties = { height: 8, overflow: 'hidden', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))' }
const tabBarStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
  marginTop: 4,
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
}
const tabStyle: CSSProperties = {
  padding: '6px 12px',
  border: 0,
  borderBottom: '2px solid transparent',
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: '20px',
  cursor: 'pointer',
}
const tabActiveStyle: CSSProperties = {
  borderBottom: '2px solid var(--dsw-alias-brand-primary)',
  color: 'var(--dsw-alias-label-primary)',
}

/** One selectable policy option in the model-scope switch. */
interface ScopeOption {
  scope: WorkBuddyModelScope
  labelKey: WorkBuddySettingsKey
  hintKey: WorkBuddySettingsKey
}

const SCOPE_OPTIONS: readonly ScopeOption[] = [
  { scope: 'free', labelKey: 'scopeFree', hintKey: 'scopeFreeHint' },
  { scope: 'all', labelKey: 'scopeAll', hintKey: 'scopeAllHint' },
]

/** Format a credit count without a locale dependency the card cannot assume. */
function formatCount(value: number): string {
  return value.toLocaleString()
}

/** Format an epoch millisecond timestamp for display, degrading to a raw value. */
function formatTime(value: number | undefined): string {
  if (value === undefined) return ''
  try {
    return new Date(value).toLocaleString()
  } catch {
    return String(value)
  }
}

/** Format a context window as a compact token count (`1M`, `192K`). */
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`
  return String(tokens)
}

/** Localize an upstream promotional badge label, with an unknown-badge fallback. */
function modelBadgeLabel(badge: string, t: WorkBuddyPluginCardInjected['t']): string {
  if (badge === '限时免费') return t('freeModel')
  return badge
}

/** One line describing where the buddy is, or that today's trip is used up. */
function growthLabel(
  growth: { state: string; dailyLimitReached?: boolean; locationName?: string; claimedToday?: number },
  t: WorkBuddyPluginCardInjected['t'],
): string {
  const place = growth.locationName
  if (growth.state === 'arrived') return place === undefined ? t('growthArrivedNoPlace') : t('growthArrived', { location: place })
  if (growth.state === 'traveling') return place === undefined ? t('growthTravelingNoPlace') : t('growthTraveling', { location: place })
  // `idle` with the limit reached is "done for today"; `idle` without it means a
  // trip is available, which the adjacent button already says. The payout comes
  // from the trip log, because `/status` reports 0 for it once the buddy is idle.
  if (growth.dailyLimitReached !== true) return ''
  return growth.claimedToday === undefined
    ? t('growthDoneToday')
    : t('growthDoneTodayClaimed', { credits: growth.claimedToday })
}

/**
 * The buddy's line: where it is, plus the live `旅行倒计时 HH:MM:SS` while it is
 * still travelling.
 *
 * The countdown ticks on its own one-second timer rather than off the status
 * document: the document is only re-read once a minute (and every five minutes
 * host-side), so a countdown driven by it would jump. Nothing is fetched — this
 * is arithmetic on `arriveAt`, which the host already sent.
 *
 * The countdown is part of the same span, not a second line: "正在前往咖啡馆"
 * and its remaining time are one statement about one trip. It is dropped once
 * the time is up, so an arrived buddy never shows a stale `00:00:00`; the host
 * poll swaps the label to "已从…回来" at its own pace.
 */
function GrowthLine(
  { growth, t }: { growth: { state: string; dailyLimitReached?: boolean; locationName?: string; arriveAt?: number; claimedToday?: number }; t: WorkBuddyPluginCardInjected['t'] },
): ReactElement | null {
  const arriveAt = growth.arriveAt
  const [now, setNow] = useState(() => Date.now())
  const remaining = arriveAt === undefined ? 0 : arriveAt - now
  const running = growth.state === 'traveling' && remaining > 0
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [running])
  const label = growthLabel(growth, t)
  if (label === '' && !running) return null
  return (
    <span style={modelRateStyle}>
      {label}
      {running ? `${label === '' ? '' : ' '}${t('growthCountdown', { time: formatCountdown(remaining) })}` : ''}
    </span>
  )
}

/** Result of one control-route call. */
interface ControlResult {
  ok: boolean
  error?: string
  authUrl?: string
  pending?: boolean
  /** Normalized note the host stored, so the card need not re-read the document. */
  note?: string | null
  /** Outcome of a manual check-in: `checked-in`, `already-checked-in` or `error`. */
  checkin?: { state: string; reason?: string; claimed?: number }
}

interface ConnectivityFeedback {
  state: 'checking' | 'ok' | 'error'
  message?: string
  checkedAt?: number
}

/** One manual check-in's progress, shown until the next click. */
interface CheckinFeedback {
  state: 'running' | 'ok' | 'error'
  message?: string
}

/**
 * POST one control action with the in-process key.
 *
 * The key travels in a header rather than the body so it never lands in a log
 * line that records payloads, and the request carries no credential of its own.
 */
async function postControl(key: string, body: unknown): Promise<ControlResult> {
  try {
    const response = await fetch(WORKBUDDY_CONTROL_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [WORKBUDDY_CONTROL_KEY_HEADER]: key,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, error: text.slice(0, 200) || `HTTP ${response.status}` }
    }
    const payload = await response.json().catch(() => undefined) as {
      state?: string
      reason?: string
      authUrl?: string
      pending?: boolean
      note?: string | null
      checkin?: { state?: string; reason?: string; claimed?: number }
    } | undefined
    // A probe can answer 200 with a non-`ok` state; that is a refusal the card
    // must show, not a success.
    if (payload !== undefined && payload.state !== undefined && payload.state !== 'ok' && payload.state !== 'cleared') {
      return { ok: false, error: payload.reason ?? payload.state }
    }
    const checkin = payload?.checkin
    return {
      ok: true,
      ...typeof payload?.authUrl === 'string' && payload.authUrl !== '' ? { authUrl: payload.authUrl } : {},
      ...payload !== undefined && 'note' in payload ? { note: typeof payload.note === 'string' ? payload.note : null } : {},
      ...checkin === undefined || typeof checkin.state !== 'string' ? {} : {
        checkin: {
          state: checkin.state,
          ...typeof checkin.reason === 'string' ? { reason: checkin.reason } : {},
          ...typeof checkin.claimed === 'number' ? { claimed: checkin.claimed } : {},
        },
      },
      pending: payload?.pending === true,
    }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** One model row: name, badges, and why it is or is not selectable. */
function ModelRow(props: {
  model: WorkBuddyWebModelBadge
  t: WorkBuddyPluginCardInjected['t']
  disabled: boolean
  onToggle: (enabled: boolean) => void
}): ReactElement {
  const { model, t, disabled, onToggle } = props
  return (
    <li style={modelRowStyle}>
      <div style={{ display: 'flex', minWidth: 0, flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 14, color: 'var(--dsw-alias-label-primary)' }}>{model.name}</span>
        <span style={modelRateStyle}>
          {model.credits === undefined ? model.id : t('rate', { rate: model.credits })}
          {model.contextWindow === undefined ? '' : ` · ${t('contextWindow', { tokens: formatContext(model.contextWindow) })}`}
        </span>
      </div>
      <div style={modelBadgeStyle}>
        {(model.badges ?? []).map(badge => (
          <span key={badge} style={chipStyle}>{modelBadgeLabel(badge, t)}</span>
        ))}
        {model.free === true
          ? <span style={chipStyle}>{t('freeModel')}</span>
          : <span style={mutedChipStyle}>{t('scopePaid')}</span>}
        {model.selectable === true ? null : <span style={mutedChipStyle}>{t('scopeHidden')}</span>}
        <Switch
          checked={model.selectable === true && model.enabled !== false}
          label={t('modelEnabled')}
          disabled={disabled || model.selectable !== true}
          onChange={onToggle}
        />
      </div>
    </li>
  )
}

/**
 * The plugin card.
 *
 * Everything it renders comes from one status document; the control route is
 * used only to change state, and a successful change triggers a re-read so the
 * card never shows an optimistic value the host did not accept.
 */
export function WorkBuddyPluginCard(props: WorkBuddyPluginCardProps): ReactElement {
  const t = props.t ?? ((key: WorkBuddySettingsKey) => key)
  const fixedRegion = props.region
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'status' | 'models'>('status')
  const [status, setStatus] = useState<WorkBuddyWebStatus | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [waitingLogin, setWaitingLogin] = useState(false)
  const [loginRegion, setLoginRegion] = useState<'cn' | 'global'>('global')
  const [authUrl, setAuthUrl] = useState<string | undefined>(undefined)
  const [regionTab, setRegionTab] = useState<'cn' | 'global'>('cn')
  const [removeAccountId, setRemoveAccountId] = useState<string | undefined>(undefined)
  const [noteAccountId, setNoteAccountId] = useState<string | undefined>(undefined)
  const [noteDraft, setNoteDraft] = useState('')
  const [connectivityFeedback, setConnectivityFeedback] = useState<Record<string, ConnectivityFeedback>>({})
  const [checkinFeedback, setCheckinFeedback] = useState<Record<string, CheckinFeedback>>({})
  const [modelQuery, setModelQuery] = useState('')
  const mounted = useRef(true)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const response = await fetch(WORKBUDDY_STATUS_PATH, { headers: { 'Accept': 'application/json' } })
      if (!response.ok) {
        setError(`${t('requestFailed')} (HTTP ${response.status})`)
        return
      }
      const document = await response.json() as WorkBuddyWebStatus
      if (!mounted.current) return
      setStatus(document)
      setError(document.status === 'error' ? document.message : undefined)
    } catch (cause: unknown) {
      if (!mounted.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [t])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Keep the host-side read-only cache warm while the card is collapsed too.
  // No model probe is part of this poll; probes are only triggered on open or by
  // an explicit test action.
  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [load])

  const regionRows = useMemo(() => status !== undefined && status.status !== 'error' ? status.regions ?? [] : [], [status])
  // The tab wins while its own region is signed in; otherwise follow whichever
  // region is, because the signed-out block has no region switcher — opening on
  // an empty cn tab must not hide a signed-in global account.
  const cardRegion: 'cn' | 'global' = fixedRegion
    ?? (regionRows.find(region => region.region === regionTab)?.signedIn === true
      ? regionTab
      : regionRows.find(region => region.signedIn === true)?.region ?? regionTab)
  const activeRegion: WorkBuddyWebRegion | undefined = regionRows.find(region => region.region === cardRegion)
  const signedInStatus = status?.status === 'signed-in' ? status : undefined
  // Everything region-shaped reads the *selected* region, never the document
  // top level. The top level is the global account, so a cn tab that fell back
  // to it showed the global model list and global credits next to cn accounts.
  const signedIn = activeRegion?.signedIn === true
  const controlKey = status !== undefined && status.status !== 'error' ? status.controlKey : undefined
  const scope: WorkBuddyModelScope = signedIn ? (activeRegion?.scope ?? 'free') : 'free'
  const probe = signedIn ? activeRegion?.probe : undefined
  const models = signedIn ? (activeRegion?.models ?? []) : []
  const priceSource = activeRegion?.priceSource
  const priceSourcePath = activeRegion?.priceSourcePath
  const autoCheckinEnabled = cardRegion === 'cn' ? activeRegion?.checkin?.enabled === true : signedInStatus?.autoCheckin === true

  // Search narrows what is shown; it never changes what a switch means.
  const visibleModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase()
    if (query === '') return models
    return models.filter(model => model.name.toLowerCase().includes(query) || model.id.toLowerCase().includes(query))
  }, [models, modelQuery])
  // Only rows the picker could actually list: a paid row under free-only scope
  // cannot be switched on, so select-all must not pretend to.
  const toggleable = useMemo(() => {
    const rows = visibleModels.filter(model => model.selectable === true)
    return { ids: rows.map(model => model.id), allOn: rows.length > 0 && rows.every(model => model.enabled !== false) }
  }, [visibleModels])

  /**
   * Run one control action, then re-read so the card reflects host state only.
   *
   * `applyPatch` turns a successful result into an optimistic document patch —
   * an action that already knows its outcome (a stored note, say) paints it
   * immediately, and the `load()` below then confirms it against host state.
   */
  const runControl = useCallback(async (
    body: unknown,
    applyPatch?: (result: ControlResult) => (document: WorkBuddyWebStatus) => WorkBuddyWebStatus,
  ): Promise<ControlResult> => {
    if (controlKey === undefined) return { ok: false, error: t('requestFailed') }
    setBusy(true)
    try {
      const result = await postControl(controlKey, body)
      if (!result.ok) {
        setError(result.error ?? t('requestFailed'))
        // A rejected write can still have taken effect in memory (that is what
        // the error says), so re-read rather than leave the switch on its old
        // value until the next poll.
        await load()
        return result
      }
      setError(undefined)
      if (applyPatch !== undefined) setStatus(current => current === undefined ? current : applyPatch(result)(current))
      await load()
      return result
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [controlKey, load, t])

  /** Paint one account's stored note into the current document, or clear it when null. */
  const withAccountNote = useCallback((region: 'cn' | 'global', accountId: string, note: string | null) => (document: WorkBuddyWebStatus): WorkBuddyWebStatus => {
    if (document.status !== 'signed-in' || document.regions === undefined) return document
    return {
      ...document,
      regions: document.regions.map(item => item.region === region
        ? { ...item, accounts: item.accounts.map(account => {
            if (account.id !== accountId) return account
            const next = { ...account }
            // `exactOptionalPropertyTypes`: drop the key rather than assign undefined.
            if (note === null) delete next.note
            else next.note = note
            return next
          }) }
        : item),
    }
  }, [])

  const onConnect = useCallback(async (region: 'cn' | 'global' = 'global'): Promise<void> => {
    if (controlKey === undefined) return
    setBusy(true)
    setLoginRegion(region)
    try {
      const result = await postControl(controlKey, { action: 'loginStart', region })
      if (!result.ok || result.authUrl === undefined) {
        setWaitingLogin(false)
        setError(result.error ?? t('loginFailed', { message: t('requestFailed') }))
        return
      }
      setError(undefined)
      setAuthUrl(result.authUrl)
      setWaitingLogin(true)
      window.open(result.authUrl, '_blank', 'noopener,noreferrer')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [controlKey, t])

  useEffect(() => {
    if (!waitingLogin || controlKey === undefined) return
    const timer = setInterval(() => {
      void (async () => {
        const result = await postControl(controlKey, { action: 'loginPoll', region: loginRegion })
        if (!result.ok) {
          setWaitingLogin(false)
          setError(t('loginFailed', { message: result.error ?? t('requestFailed') }))
          return
        }
        if (result.pending === true) return
        setWaitingLogin(false)
        setAuthUrl(undefined)
        await load()
      })()
    }, LOGIN_POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [waitingLogin, controlKey, load, loginRegion, t])

  const onScope = useCallback((next: WorkBuddyModelScope): void => {
    // Always name the region: the host falls back to global when it is missing,
    // so an unnamed write from the cn tab used to edit the global config.
    void runControl({ action: 'setScope', scope: next, region: cardRegion })
  }, [runControl, cardRegion])

  const onProbe = useCallback((model: string): void => {
    void runControl({ action: 'probe', model })
  }, [runControl])

  const onModelToggle = useCallback((model: string, enabled: boolean): void => {
    void runControl({ action: 'setModelEnabled', model, enabled, region: cardRegion })
  }, [runControl, cardRegion])

  // One request for the whole selection, not one per row: every write rewrites
  // the settings file, and a select-all over a long catalog is a burst.
  const onModelsToggle = useCallback((list: readonly string[], enabled: boolean): void => {
    if (list.length === 0) return
    void runControl({ action: 'setModelsEnabled', models: list, enabled, region: cardRegion })
  }, [runControl, cardRegion])

  const onClearProbe = useCallback((): void => {
    void runControl({ action: 'clearProbe' })
  }, [runControl])

  const selectedAccount = activeRegion?.accounts.find(account => account.selected)
  const credits = selectedAccount?.credits
  const creditsError = selectedAccount?.creditsError
  const accountRows = useMemo(() => credits?.accounts ?? [], [credits])
  const activeAccounts = activeRegion?.accounts ?? []
  const displayNickname = selectedAccount?.nickname
  const displayExpiresAt = selectedAccount?.expiresAt

  const onSelectAccount = useCallback((region: 'cn' | 'global', accountId: string): void => {
    void runControl({ action: 'selectAccount', region, accountId })
  }, [runControl])

  const onConnectivity = useCallback((region: 'cn' | 'global', accountId?: string): void => {
    const targetId = accountId ?? (region === cardRegion ? activeRegion?.selectedAccountId : undefined)
    if (targetId === undefined) return
    const key = `${region}:${targetId}`
    setConnectivityFeedback(previous => ({ ...previous, [key]: { state: 'checking' } }))
    void runControl({ action: 'connectivity', region, accountId: targetId }).then(result => {
      if (!mounted.current) return
      setConnectivityFeedback(previous => ({
        ...previous,
        [key]: result.ok
          ? { state: 'ok', checkedAt: Date.now() }
          : { state: 'error', message: result.error ?? t('requestFailed'), checkedAt: Date.now() },
      }))
    })
  }, [activeRegion?.selectedAccountId, cardRegion, runControl, t])

  /**
   * One manual check-in (which also runs the growth trip, host-side).
   *
   * The card must say something the moment it is clicked, so it paints a
   * `running` row before the round trip and replaces it with the host's own
   * outcome — including the failure reason, which the route nests under an `ok`
   * envelope precisely so it survives this path.
   */
  const onCheckin = useCallback((region: 'cn' | 'global', accountId: string): void => {
    const key = `${region}:${accountId}`
    setCheckinFeedback(previous => ({ ...previous, [key]: { state: 'running' } }))
    void runControl({ action: 'checkin', accountId }).then(result => {
      if (!mounted.current) return
      const outcome = classifyCheckin(result)
      setCheckinFeedback(previous => ({
        ...previous,
        [key]: outcome.kind === 'failed'
          ? { state: 'error', message: outcome.reason ?? t('requestFailed') }
          // A payout is the more interesting outcome, so it outranks "已签到":
          // the trip came home and paid, and that is what the user asked to see.
          : outcome.claimed === undefined
            ? { state: 'ok', message: outcome.kind === 'already' ? t('alreadyCheckedIn') : t('checkinDone') }
            : { state: 'ok', message: t('growthClaimed', { credits: outcome.claimed }) },
      }))
    })
  }, [runControl, t])

  const onRemoveAccount = useCallback((region: 'cn' | 'global', accountId: string): void => {
    const key = `${region}:${accountId}`
    if (removeAccountId !== key) {
      setRemoveAccountId(key)
      return
    }
    setRemoveAccountId(undefined)
    void runControl({ action: 'removeAccount', region, accountId })
  }, [removeAccountId, runControl])

  const onSaveNote = useCallback((region: 'cn' | 'global', accountId: string): void => {
    const key = `${region}:${accountId}`
    const draft = noteDraft
    setNoteAccountId(undefined)
    // An empty draft clears the note, which the host normalizes back to the
    // account's own nickname — the same result the old restore button produced.
    void runControl(
      { action: 'setAccountNote', region, accountId, note: draft },
      result => withAccountNote(region, accountId, result.note ?? null),
    ).then(result => {
      if (!mounted.current) return
      if (result.ok) {
        setNoteDraft('')
        return
      }
      setNoteAccountId(key)
      setNoteDraft(draft)
    })
  }, [noteDraft, runControl, withAccountNote])

  // Opening settings is the only automatic probe trigger. It never runs while
  // collapsed or from the one-minute status/credit refresh.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (!open || wasOpen.current || controlKey === undefined || status === undefined || !signedIn) return
    wasOpen.current = true
    const selected = activeRegion?.selectedAccountId
    void onConnectivity(cardRegion, selected)
  }, [activeRegion?.selectedAccountId, cardRegion, controlKey, onConnectivity, open, status])
  useEffect(() => {
    if (!open) wasOpen.current = false
  }, [open])

  return (
    <div style={cardStyle}>
      <button
        type="button"
        style={headerStyle}
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <span style={headTextStyle}>
          <span style={nameStyle}>{fixedRegion === 'cn' ? `${t('title')} · ${t('regionCn')}` : fixedRegion === 'global' ? `${t('title')} · ${t('regionGlobal')}` : t('title')}</span>
          <span style={descriptionStyle}>{t('intro')}</span>
        </span>
        <ChevronDownOutline14 open={open} />
      </button>

      {open
        ? (
          <div style={cardBodyStyle}>
            {loading && status === undefined ? <p style={bodyStyle}>{t('loading')}</p> : null}

            {status !== undefined && status.status !== 'error' && !signedIn
              ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={rowStyle}>
                    <span style={statusStyle}>{waitingLogin ? t('connecting') : t('signedOut')}</span>
                    <span style={{ display: 'flex', gap: 8 }}>
                      <button type="button" style={buttonStyle} onClick={() => { void load() }} disabled={loading}>
                        {loading ? t('refreshing') : t('refresh')}
                      </button>
                      <button
                        type="button"
                        style={buttonStyle}
                        onClick={() => { void onConnect(cardRegion) }}
                        disabled={busy || waitingLogin || controlKey === undefined}
                      >
                        {t('connect')}
                      </button>
                    </span>
                  </div>
                  <p style={bodyStyle}>{t('signedOutHint')}</p>
                  {authUrl === undefined
                    ? null
                    : (
                      <a href={authUrl} target="_blank" rel="noreferrer" style={{ ...buttonStyle, display: 'inline-block', textDecoration: 'none' }}>
                        {t('openLogin')}
                      </a>
                     )}
                </div>
              )
              : null}

            {status !== undefined && status.status === 'error'
              ? <p style={errorStyle}>{status.message}</p>
              : null}

            {signedIn
              ? (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {/* The region row sits above 状态/模型: it picks which region's
                      whole card the two tabs below are showing. */}
                  {fixedRegion !== undefined || regionRows.length === 0
                    ? null
                    : (
                      <div style={tabBarStyle} role="tablist" aria-label={t('accountsHeading')}>
                        {(['cn', 'global'] as const).map(region => (
                          <button key={region} type="button" role="tab" aria-selected={cardRegion === region} style={cardRegion === region ? { ...tabStyle, ...tabActiveStyle } : tabStyle} onClick={() => { setRegionTab(region) }}>
                            {region === 'global' ? t('regionGlobal') : t('regionCn')}
                          </button>
                        ))}
                      </div>
                     )}
                  <div style={tabBarStyle} role="tablist">
                    {(['status', 'models'] as const).map(key => (
                      <button
                        key={key}
                        type="button"
                        role="tab"
                        aria-selected={tab === key}
                        style={tab === key ? { ...tabStyle, ...tabActiveStyle } : tabStyle}
                        onClick={() => { setTab(key) }}
                      >
                        {key === 'status' ? t('tabStatus') : t('tabModels')}
                      </button>
                    ))}
                  </div>

                  {tab === 'status'
                    ? (
                      <div style={sectionStyle}>
                        {regionRows.length === 0 ? null : (
                           <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                             {/* The master switch gates every per-account 自动签到 row below
                                   it, so it rides the 账号 heading instead of owning a
                                   line of its own. */}
                               <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                                 <h4 style={sectionTitleStyle}>{t('accountsHeading')}</h4>
                                 {signedIn && cardRegion === 'cn'
                                   ? <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                       <span style={bodyStyle}>{t('autoCheckin')}</span>
                                       <Switch checked={autoCheckinEnabled} label={t('autoCheckin')} disabled={busy || controlKey === undefined} onChange={enabled => { void runControl({ action: 'setAutoCheckin', enabled }) }} />
                                     </span>
                                   : null}
                               </div>
                             {activeAccounts.length === 0
                               ? <p style={bodyStyle}>{t('noAccounts')}</p>
                               : activeAccounts.map(account => (
                                 <div key={account.id} style={account.selected ? { ...accountItemStyle, ...accountItemSelectedStyle } : accountItemStyle}>
                                   <div style={rowStyle}>
                                     <span style={statusStyle}>
                                       <span>{account.note ?? account.nickname ?? account.id}</span>
                                        {account.note !== undefined && account.nickname !== undefined ? <span style={accountMetaStyle}>{account.nickname}</span> : null}
                                       {account.selected ? <span style={chipStyle}>{t('selectedAccount')}</span> : null}
                                      {account.domain === undefined ? null : <span style={accountMetaStyle}>{account.domain}</span>}
                                     </span>
                                     <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                       <button type="button" style={buttonStyle} disabled={busy || account.selected} onClick={() => { onSelectAccount(cardRegion, account.id) }}>
                                         {t('useAccount')}
                                       </button>
                                       <button type="button" style={buttonStyle} disabled={busy} onClick={() => { setNoteAccountId(noteAccountId === `${cardRegion}:${account.id}` ? undefined : `${cardRegion}:${account.id}`); setNoteDraft(account.note ?? '') }}>
                                          {t('editNote')}
                                        </button>
                                         {activeAccounts.length > 1
                                          ? <button type="button" style={buttonStyle} disabled={busy} onClick={() => { onRemoveAccount(cardRegion, account.id) }}>
                                            {removeAccountId === `${cardRegion}:${account.id}` ? t('removeConfirm') : t('removeAccount')}
                                          </button>
                                          : null}
                                        {removeAccountId === `${cardRegion}:${account.id}`
                                          ? <button type="button" style={buttonStyle} disabled={busy} onClick={() => { setRemoveAccountId(undefined) }}>{t('removeCancel')}</button>
                                          : null}
                                        <button type="button" style={buttonStyle} aria-busy={connectivityFeedback[`${cardRegion}:${account.id}`]?.state === 'checking'} disabled={busy} onClick={() => { onConnectivity(cardRegion, account.id) }}>
                                         {connectivityFeedback[`${cardRegion}:${account.id}`]?.state === 'checking' ? t('testingConnectivity') : t('testConnectivity')}
                                       </button>
                                     </span>
                                   </div>
                                   {noteAccountId === `${cardRegion}:${account.id}`
                                      ? <div style={noteEditorStyle}>
                                          <input
                                            type="text"
                                            value={noteDraft}
                                            maxLength={80}
                                            placeholder={account.nickname ?? account.id}
                                            aria-label={t('notePlaceholder')}
                                            style={noteInputStyle}
                                            disabled={busy}
                                            onChange={event => { setNoteDraft(event.currentTarget.value) }}
                                            onKeyDown={event => {
                                              if (event.key === 'Enter' && !event.nativeEvent.isComposing) onSaveNote(cardRegion, account.id)
                                            }}
                                          />
                                          <button type="button" style={buttonStyle} disabled={busy} onClick={() => { onSaveNote(cardRegion, account.id) }}>{t('saveNote')}</button>
                                          <button type="button" style={buttonStyle} disabled={busy} onClick={() => { setNoteAccountId(undefined) }}>{t('cancelNote')}</button>
                                        </div>
                                      : null}
                                    {account.credits === undefined ? null : <span style={modelRateStyle}>{t('creditsTotal', { total: formatCount(account.credits.total) })}</span>}
                                    {connectivityFeedback[`${cardRegion}:${account.id}`] === undefined
                                      ? null
                                      : <span role="status" aria-live="polite" style={{ ...connectivityStyle, color: connectivityFeedback[`${cardRegion}:${account.id}`]!.state === 'error' ? 'var(--dsw-alias-state-error-primary)' : connectivityFeedback[`${cardRegion}:${account.id}`]!.state === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)' }}>
                                          {connectivityFeedback[`${cardRegion}:${account.id}`]!.state === 'checking'
                                            ? t('testingConnectivity')
                                            : connectivityFeedback[`${cardRegion}:${account.id}`]!.state === 'ok'
                                              ? t('connectivityOk')
                                              : t('connectivityFailed', { message: connectivityFeedback[`${cardRegion}:${account.id}`]!.message ?? t('requestFailed') })}
                                          {connectivityFeedback[`${cardRegion}:${account.id}`]!.checkedAt === undefined ? '' : ` · ${t('connectivityCheckedAt', { time: formatTime(connectivityFeedback[`${cardRegion}:${account.id}`]!.checkedAt) })}`}
                                        </span>}
                                   {cardRegion === 'cn'
                                     ? <div style={accountRowStyle}>
                                         <div style={accountTextStyle}>
                                           {checkinFeedback[`${cardRegion}:${account.id}`] === undefined
                                             ? null
                                             : <span role="status" aria-live="polite" style={{ ...modelRateStyle, color: checkinFeedback[`${cardRegion}:${account.id}`]!.state === 'error' ? 'var(--dsw-alias-state-error-primary)' : checkinFeedback[`${cardRegion}:${account.id}`]!.state === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)' }}>
                                                 {checkinFeedback[`${cardRegion}:${account.id}`]!.state === 'running'
                                                   ? t('checkingIn')
                                                   : checkinFeedback[`${cardRegion}:${account.id}`]!.state === 'error'
                                                     ? t('checkinFailed', { message: checkinFeedback[`${cardRegion}:${account.id}`]!.message ?? t('requestFailed') })
                                                     : checkinFeedback[`${cardRegion}:${account.id}`]!.message ?? t('checkinDone')}
                                               </span>}
                                           {account.growth === undefined ? null : <GrowthLine growth={account.growth} t={t} />}
                                           {account.checkin === undefined
                                             ? null
                                             : <span style={modelRateStyle}>
                                                 {account.checkin.todayCheckedIn === true
                                                   ? t('todayCreditEarned', { credit: formatCount(account.checkin.todayCredit ?? 0) })
                                                   : t('todayCreditPending')}
                                                 {account.checkin.streakDays === undefined || account.checkin.streakDays <= 1
                                                   ? ''
                                                   : ` · ${t('streakDays', { days: account.checkin.streakDays })}`}
                                               </span>}
                                         </div>
                                         <span style={accountActionsStyle}>
                                           {/* Manual check-in, inline to the left of 自动签到. It is the only path
                                               when the script is off, so it is always rendered — never hidden behind
                                               a "today already checked in" condition. It does dim once today's work
                                               is truly finished: the daily check-in, the buddy's trip, and the
                                               growth tasks this same click sweeps. Greying it out while any of
                                               the three is still claimable would strand that reward behind a
                                               dead button. */}
                                           {(() => {
                                             const doneForToday = checkinExhausted(account.checkin, account.growth, account.tasks)
                                             // The title rides a wrapper span: a disabled <button> does not
                                             // reliably raise its own tooltip, and the dimmed state needs to
                                             // explain itself on hover.
                                             return (
                                               <span {...doneForToday ? { title: t('checkinAlreadyDone') } : {}}>
                                                 <button
                                                   type="button"
                                                   style={doneForToday ? { ...checkinButtonStyle, opacity: 0.5, cursor: 'default' } : checkinButtonStyle}
                                                   disabled={busy || controlKey === undefined || doneForToday}
                                                   onClick={() => { onCheckin(cardRegion, account.id) }}
                                                 >
                                                   {t('checkinNow')}
                                                 </button>
                                               </span>
                                             )
                                           })()}
                                           <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                                             <span>{t('checkinSelected')}</span>
                                             <Switch checked={autoCheckinEnabled && account.checkinEnabled === true} label={t('checkinSelected')} {...autoCheckinEnabled ? {} : { title: t('checkinNeedsScript') }} disabled={busy || controlKey === undefined || !autoCheckinEnabled} onChange={enabled => { void runControl({ action: 'setCheckinEnabled', accountId: account.id, enabled }) }} />
                                           </label>
                                         </span>
                                       </div>
                                     : null}
                                 </div>
                               ))}

                             <div style={rowStyle}>
                               
                               <button type="button" style={buttonStyle} disabled={busy || controlKey === undefined} onClick={() => { void onConnect(cardRegion) }}>{t('addAccount')}</button>
                             </div>
                             <p style={modelRateStyle}>{t('refreshPolicyHint')}</p>
                             <div style={rowStyle}>
                               <label style={modelRateStyle}>{t('activeRefresh')} <input type="number" min={1} defaultValue={signedInStatus?.refreshPolicy?.activeMinutes ?? 15} onBlur={event => { void runControl({ action: 'setRefreshPolicy', activeMinutes: Number(event.currentTarget.value), inactiveMinutes: signedInStatus?.refreshPolicy?.inactiveMinutes ?? 60 }) }} style={numberInputStyle} /></label>
                               <label style={modelRateStyle}>{t('inactiveRefresh')} <input type="number" min={1} defaultValue={signedInStatus?.refreshPolicy?.inactiveMinutes ?? 60} onBlur={event => { void runControl({ action: 'setRefreshPolicy', activeMinutes: signedInStatus?.refreshPolicy?.activeMinutes ?? 15, inactiveMinutes: Number(event.currentTarget.value) }) }} style={numberInputStyle} /></label>
                             </div>
                             </div>
                         )}
                         <h4 style={sectionTitleStyle}>{t('accountHeading')}</h4>
                        <div style={rowStyle}>
                          <span style={statusStyle}>
                            {displayNickname === undefined ? t('signedInAs', { nickname: '—' }) : t('signedInAs', { nickname: displayNickname })}
                          </span>
                          <span style={{ display: 'flex', gap: 8 }}>
                            <button type="button" style={buttonStyle} onClick={() => { void load() }} disabled={loading}>
                              {loading ? t('refreshing') : t('refresh')}
                            </button>
                            <button
                              type="button"
                              style={buttonStyle}
                              onClick={() => { void runControl({ action: 'logout', region: cardRegion }) }}
                              disabled={busy}
                            >
                              {t('signOutAll')}
                            </button>
                          </span>
                        </div>
                        {displayExpiresAt === undefined
                          ? null
                          : <p style={bodyStyle}>{t('accessTokenExpires', { time: formatTime(displayExpiresAt) })}</p>}

                        <h4 style={sectionTitleStyle}>{t('creditsHeading')}</h4>
                        {creditsError === undefined ? null : <p style={errorStyle}>{t('creditsError', { message: creditsError })}</p>}
                        {credits === undefined
                          ? null
                          : (
                            <div style={quotaGroupStyle}>
                              <span style={bodyStyle}>{t('creditsTotal', { total: formatCount(credits.total) })}</span>
                              {accountRows.length === 0
                                ? null
                                : (
                                  <div style={quotaGroupStyle}>
                                    <span style={quotaLabelStyle}>{t('creditsDetailHeading')}</span>
                                    {accountRows.map((account, index) => (
                                      <div key={`${account.packageName}-${account.expiresAt ?? 'none'}-${index}`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                        <span style={quotaLabelStyle}>
                                          <span style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                                            <span>{account.capacityType === 4 ? t('creditBucketPlan') : t('creditBucketBonus')}</span>
                                            {account.expiresAt === undefined
                                              ? null
                                              : <span style={accountMetaStyle}>{t('creditPackageExpires', { time: formatExpiry(account.expiresAt) })}</span>}
                                            {account.expiresAt === undefined
                                              ? null
                                              : (() => {
                                                  const days = daysUntilExpiry(account.expiresAt)
                                                  if (days > EXPIRY_SOON_DAYS) return null
                                                  return (
                                                    <span style={days <= 0 ? expiringVerySoonStyle : expiringSoonStyle}>
                                                      {days <= 0 ? t('creditExpired') : t('creditExpiresInDays', { days })}
                                                    </span>
                                                  )
                                                })()}
                                          </span>
                                          <span>
                                            {account.size > 0
                                              ? t('creditUsedOfSize', { used: formatCount(account.size - account.remain), size: formatCount(account.size) })
                                              : t('creditPackageUnknownSize', { remain: formatCount(account.remain) })}
                                          </span>
                                        </span>
                                        {account.size > 0
                                          ? (
                                            <div style={progressTrackStyle}>
                                              <div style={{
                                                width: `${Math.max(0, Math.min(100, Math.round((account.remain / account.size) * 100)))}%`,
                                                height: '100%',
                                                background: 'var(--dsw-alias-brand-primary)',
                                              }} />
                                            </div>
                                          )
                                          : null}
                                      </div>
                                    ))}
                                  </div>
                                )}
                            </div>
                          )}
                      </div>
                    )
                    : (
                      <div style={sectionStyle}>
                        <h4 style={sectionTitleStyle}>{t('scopeHeading')}</h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {SCOPE_OPTIONS.map(option => (
                            <label
                              key={option.scope}
                              style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 10,
                                padding: '8px 10px',
                                border: '1px solid var(--dsw-alias-border-l2)',
                                borderRadius: 8,
                                cursor: busy ? 'default' : 'pointer',
                              }}
                            >
                              <input
                                type="radio"
                                name="workbuddy-ai-model-scope"
                                checked={scope === option.scope}
                                disabled={busy || controlKey === undefined}
                                onChange={() => { onScope(option.scope) }}
                                style={{
                                  ...radioInputStyle,
                                  borderColor: scope === option.scope ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
                                  background: scope === option.scope ? 'var(--dsw-alias-brand-primary)' : 'transparent',
                                  boxShadow: scope === option.scope ? 'inset 0 0 0 4px var(--dsw-alias-bg-layer-1)' : 'none',
                                }}
                              />
                              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                <span style={{ fontSize: 14, color: 'var(--dsw-alias-label-primary)' }}>
                                  {t(option.labelKey)}
                                  {scope === option.scope ? <span style={{ ...mutedChipStyle, marginLeft: 8 }}>{t('scopeActive')}</span> : null}
                                </span>
                                <span style={modelRateStyle}>{t(option.hintKey)}</span>
                              </span>
                            </label>
                          ))}
                        </div>
                        {busy ? <p style={bodyStyle}>{t('scopeSaving')}</p> : null}

                        <h4 style={sectionTitleStyle}>{t('modelsHeading')}</h4>
                        <p style={modelRateStyle}>{t('modelsIntro')}</p>
                        <p style={modelRateStyle}>{t('modelsSwitchHint')}</p>
                        <p style={modelRateStyle}>
                          {priceSource === 'upstream' ? t('priceSourceUpstream') : priceSource === 'builtin' ? t('priceSourceBuiltin') : t('priceSourceCache')}
                        </p>
                        {priceSourcePath === undefined
                          ? null
                          : <p style={modelRateStyle}>{t('priceSourcePath', { path: priceSourcePath })}</p>}
                        {models.length === 0
                          ? <p style={bodyStyle}>{t('modelsEmpty')}</p>
                          : (
                            <>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <input
                                  type="search"
                                  value={modelQuery}
                                  placeholder={t('modelSearch')}
                                  onChange={event => { setModelQuery(event.target.value) }}
                                  style={{ ...numberInputStyle, flex: '1 1 auto', width: 'auto' }}
                                />
                                <button
                                  type="button"
                                  style={toolbarButtonStyle}
                                  disabled={busy || controlKey === undefined || toggleable.ids.length === 0}
                                  onClick={() => { onModelsToggle(toggleable.ids, !toggleable.allOn) }}
                                >
                                  {toggleable.allOn ? t('modelsUnselectAll') : t('modelsSelectAll')}
                                </button>
                              </div>
                              {visibleModels.length === 0
                                ? <p style={bodyStyle}>{t('modelsNoMatch')}</p>
                                : (
                                  <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                                    {visibleModels.map(model => (
                                      <ModelRow
                                        key={model.id}
                                        model={model}
                                        t={t}
                                        disabled={busy || controlKey === undefined}
                                        onToggle={enabled => { onModelToggle(model.id, enabled) }}
                                      />
                                    ))}
                                  </ul>
                                )}
                            </>
                          )}

                        {probe === undefined ? null : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <h4 style={sectionTitleStyle}>{t('probeHeading')}</h4>
                            <p style={modelRateStyle}>{t('probeIntro')}</p>
                            <p style={modelRateStyle}>{t('probeCandidates', { count: probe.candidates.length })}</p>
                            {probe.candidates.length === 0
                              ? <p style={bodyStyle}>{t('probeResultEmpty')}</p>
                              : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                  {probe.candidates.map(id => (
                                    <div key={id} style={rowStyle}>
                                      <span style={bodyStyle}>{id}</span>
                                      <button
                                        type="button"
                                        style={buttonStyle}
                                        disabled={busy || probe.running}
                                        onClick={() => { onProbe(id) }}
                                      >
                                        {probe.running ? t('probeRunning', { model: id }) : t('probeStart')}
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              )}
                            {probe.results.length === 0
                              ? null
                              : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                  {probe.results.map(result => (
                                    <span key={result.id} style={modelRateStyle}>
                                      {result.validation === 'validating'
                                        ? t('probeResultVerified', { levels: result.efforts.join(', ') || t('probeResultNoLevels') })
                                        : result.validation === 'non-validating'
                                          ? t('probeResultNotValidating')
                                          : t('probeResultUnknown')}
                                      {` · ${t('probeResultAt', { time: formatTime(result.probedAt) })}`}
                                    </span>
                                  ))}
                                  <button type="button" style={buttonStyle} disabled={busy} onClick={onClearProbe}>
                                    {t('probeClear')}
                                  </button>
                                </div>
                              )}
                          </div>
                        )}
                      </div>
                    )}

                  {error === undefined ? null : <p style={{ ...errorStyle, paddingTop: 12 }}>{error}</p>}
                </div>
              )
              : null}
          </div>
        )
        : null}
    </div>
  )
}
