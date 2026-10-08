/**
 * Node-free helpers shared by the Host and browser halves.
 *
 * @module dsh-workbuddy/display
 */

/**
 * Format an epoch millisecond timestamp the way the WorkBuddy app writes
 * package dates: Beijing wall clock, `YYYY/MM/DD HH:mm:ss`, zero padded, no
 * locale, no AM/PM.
 *
 * It lives here, not in the card, for two reasons: the card cannot be imported
 * by a test (it pulls `@deepseek-ai/dsh-client-ui-primitives`, which resolves
 * only inside DSH), and the offset is a *formatting* choice on top of the
 * parsing choice `parseUpstreamExpiry` already made - same +08:00 the upstream
 * writes its wall clock in.
 */
export function formatExpiry(value: number | undefined): string {
  if (value === undefined) return ''
  const date = new Date(value + 8 * 3_600_000)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

/**
 * Days left before a package expires, rounded up so anything still in the
 * future reads as at least one day.
 *
 * `Math.ceil`, not `round` or `floor`: a pack expiring in six hours is "1 day",
 * not "0 days" — rounding would print a package that is still usable as already
 * gone. Zero and below mean expired.
 */
export function daysUntilExpiry(expiresAt: number, now: number = Date.now()): number {
  // `Math.ceil` of a tiny negative is `-0`, which `Object.is` and strict
  // equality treat as different from `0`; normalize so the card's `days <= 0`
  // check never sees a value that prints as `-0`.
  const days = Math.ceil((expiresAt - now) / 86_400_000)
  return days === 0 ? 0 : days
}

/** Whole days at or below which an expiring package is worth flagging. */
export const EXPIRY_SOON_DAYS = 7

/**
 * `HH:MM:SS` left on a trip, clamped at zero.
 *
 * `Math.floor`, not `ceil`: a countdown that reads `00:00:01` while the buddy is
 * already home would be a lie in the other direction. Hours are not wrapped at
 * 24 — a trip longer than a day should read `26:00:00`, not `02:00:00`.
 */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000))
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

/**
 * Whether the manual check-in button should be dimmed for today.
 *
 * Today's check-in being done is *not* enough on its own: this one click also
 * sends the buddy on its trip and sweeps the growth-center tasks, so a finished
 * check-in alongside anything still claimable must keep the button live. Only
 * when all three are spent is there nothing left to press it for.
 *
 * `tasks` is optional so the two-argument callers (and the older tests) keep
 * their meaning: with no sweep recorded, the task half cannot gate the button.
 */
export function checkinExhausted(
  checkin: { todayCheckedIn?: boolean } | undefined,
  growth: { state?: string; dailyLimitReached?: boolean } | undefined,
  tasks?: { outstanding?: number } | undefined,
): boolean {
  if (checkin?.todayCheckedIn !== true) return false
  if (tasks?.outstanding !== undefined && tasks.outstanding > 0) return false
  if (growth === undefined) return true
  if (growth.state === 'arrived') return false
  return !(growth.state === 'idle' && growth.dailyLimitReached !== true)
}

/**
 * What a manual check-in round trip should tell the user.
 *
 * Two independent things can go wrong and they need different wording: the
 * request itself can fail (`ok: false`), or the request can succeed while the
 * *action* failed — the host answers `200 { state: 'ok', checkin: { state:
 * 'error', reason } }` so the reason survives the envelope. Both are
 * `kind: 'failed'`; `reason` is the host's own text and must not be swallowed.
 *
 * This lives here because the card cannot be imported by a test, and it is the
 * exact branch that made a successful check-in look like nothing happened.
 */
export type CheckinOutcomeKind = 'done' | 'already' | 'failed'

export interface CheckinOutcome {
  kind: CheckinOutcomeKind
  /** Host-supplied failure text; only present when `kind` is `'failed'`. */
  reason?: string
  /**
   * Credits the growth trip just paid out, when it claimed something. A manual
   * check-in also runs the trip, and "已签到" alone hides the reward that landed.
   */
  claimed?: number
}

export function classifyCheckin(result: {
  ok: boolean
  error?: string
  checkin?: { state?: string; reason?: string; claimed?: number }
}): CheckinOutcome {
  if (!result.ok) {
    return result.error === undefined ? { kind: 'failed' } : { kind: 'failed', reason: result.error }
  }
  const state = result.checkin?.state
  if (state === 'error') {
    return result.checkin?.reason === undefined ? { kind: 'failed' } : { kind: 'failed', reason: result.checkin.reason }
  }
  const claimed = result.checkin?.claimed
  return {
    kind: state === 'already-checked-in' ? 'already' : 'done',
    ...claimed === undefined ? {} : { claimed },
  }
}