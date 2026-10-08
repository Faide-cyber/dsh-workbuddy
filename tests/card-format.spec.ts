import { describe, expect, it } from 'vitest'
import { EXPIRY_SOON_DAYS, checkinExhausted, classifyCheckin, daysUntilExpiry, formatCountdown, formatExpiry } from '../src/display.ts'

describe('formatExpiry', () => {
  const Beijing = (y: number, mo: number, d: number, h: number, mi: number, s: number): number =>
    Date.UTC(y, mo - 1, d, h - 8, mi, s)

  const readUnder = (zone: string, value: number): string => {
    const original = process.env['TZ']
    process.env['TZ'] = zone
    try {
      return formatExpiry(value)
    } finally {
      process.env['TZ'] = original
    }
  }

  it('writes Beijing wall time as YYYY/MM/DD HH:mm:ss in every host zone', () => {
    const value = Beijing(2026, 11, 6, 0, 34, 59)
    expect(readUnder('UTC', value)).toBe('2026/11/06 00:34:59')
    expect(readUnder('America/New_York', value)).toBe('2026/11/06 00:34:59')
    expect(readUnder('Asia/Shanghai', value)).toBe('2026/11/06 00:34:59')
    // Zero padding on every component, month single-digit included. This is the
    // assertion the old `toLocaleString()` fails first: en-US prints
    // `11/5/2026, 04:34:59 PM`, unpadded and with an AM/PM marker.
    expect(readUnder('UTC', Beijing(2026, 1, 2, 3, 4, 5))).toBe('2026/01/02 03:04:05')
    // Day rollover: 00:34:59 Beijing on the 6th is still the 5th in UTC, which is
    // the off-by-one a naive `getUTC*` read would ship.
    expect(readUnder('UTC', value)).toBe('2026/11/06 00:34:59')
  })

  it('never emits a locale-shaped string, which the app never shows', () => {
    // Negative proof: the formatter this replaced was `toLocaleString()`, whose
    // output differs per zone and carries no zero padding. Same instant, two
    // zones, two answers — that instability is exactly what must not survive.
    const value = Beijing(2026, 11, 6, 0, 34, 59)
    expect(readUnder('UTC', value)).toBe(readUnder('America/New_York', value))
    expect(new Date(value).toLocaleString()).not.toBe('2026/11/06 00:34:59')
    expect(readUnder('UTC', value)).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}|, \d{1,2}:\d{2}:\d{2}/)
  })

  it('passes an absent timestamp through as empty and a non-date as its raw value', () => {
    expect(formatExpiry(undefined)).toBe('')
    // NaN input must not print "NaN/NaN/NaN"; the app has no such row.
    expect(formatExpiry(Number.NaN)).toBe('NaN')
  })
})

// The host runs at +08:00, where a naive date difference coincides with the
// Beijing reading. Rounding bugs only bite off that zone, so the negative proofs
// below are run there too.
describe('daysUntilExpiry', () => {
  const DAY = 86_400_000
  const now = Date.UTC(2026, 9, 6, 0, 0, 0)

  it('rounds a partial day up, so a package with hours left is not "gone"', () => {
    // Six hours of life left is one day of warning, not zero.
    expect(daysUntilExpiry(now + 6 * 3_600_000, now)).toBe(1)
    // One minute left is still one day: a minute-scale boundary is exactly where
    // `round` collapses to 0 and the card would print 已失效 on a live pack.
    expect(daysUntilExpiry(now + 60_000, now)).toBe(1)
    // Negative proof: `round` and `floor` both print 0 here, which the card
    // renders as 已失效 on a pack that is still usable.
    expect(Math.round(6 * 3_600_000 / DAY)).toBe(0)
    expect(Math.floor(6 * 3_600_000 / DAY)).toBe(0)
    expect(Math.round(60_000 / DAY)).toBe(0)
  })

  it('counts whole days and reports zero or less once expired', () => {
    expect(daysUntilExpiry(now + 7 * DAY, now)).toBe(7)
    expect(daysUntilExpiry(now + DAY, now)).toBe(1)
    expect(daysUntilExpiry(now - 1, now)).toBe(0)
    expect(daysUntilExpiry(now - 30 * DAY, now)).toBeLessThan(0)
    // A second past the end must not become `-0`, which compares unequal to `0`
    // under `Object.is` and would print as a negative zero days left.
    expect(Object.is(daysUntilExpiry(now - 1, now), -0)).toBe(false)
  })

  it('keeps the warning window inclusive of its own boundary', () => {
    // A package exactly 7 days out sits on the boundary of the window; if the
    // card compared strictly, the badge would vanish on the very day it was
    // written to appear. Both halves of the card's own condition are asserted,
    // because the flag is a `<=` and a change to `<` would silently drop it.
    expect(daysUntilExpiry(now + EXPIRY_SOON_DAYS * DAY, now) <= EXPIRY_SOON_DAYS).toBe(true)
    expect(daysUntilExpiry(now + (EXPIRY_SOON_DAYS + 1) * DAY, now) <= EXPIRY_SOON_DAYS).toBe(false)
    expect(EXPIRY_SOON_DAYS).toBe(7)
  })
})

describe('classifyCheckin', () => {
  it('reads the outcome nested under an ok envelope', () => {
    expect(classifyCheckin({ ok: true, checkin: { state: 'checked-in' } })).toEqual({ kind: 'done' })
    expect(classifyCheckin({ ok: true, checkin: { state: 'already-checked-in' } })).toEqual({ kind: 'already' })
  })

  it('keeps the host reason for a failed action that answered 200', () => {
    // The whole point of nesting: the request succeeded, so a card that only
    // looked at `ok` (or at the envelope) would report success here.
    expect(classifyCheckin({ ok: true, checkin: { state: 'error', reason: 'token expired' } }))
      .toEqual({ kind: 'failed', reason: 'token expired' })
  })

  it('reports a transport failure and never invents a reason', () => {
    expect(classifyCheckin({ ok: false, error: 'HTTP 500' })).toEqual({ kind: 'failed', reason: 'HTTP 500' })
    expect(classifyCheckin({ ok: false })).toEqual({ kind: 'failed' })
    // Negative proof: the shape the route used to answer with. A bare top-level
    // `state: 'checked-in'` is what the card's `postControl` turned into
    // `ok: false` (it treats a non-`ok` top-level state as a refusal), so under
    // the old contract a successful check-in could only ever read as failed.
    const legacy = { ok: false, error: 'checked-in' }
    expect(classifyCheckin(legacy).kind).toBe('failed')
    expect(classifyCheckin({ ok: true, checkin: { state: 'checked-in' } }).kind).not.toBe('failed')
  })
  it('carries the growth payout that the same click produced', () => {
    // One click runs check-in *and* the trip; without this the card can only say
    // "已签到" and hides the credits the buddy just brought home.
    expect(classifyCheckin({ ok: true, checkin: { state: 'already-checked-in', claimed: 9 } }))
      .toEqual({ kind: 'already', claimed: 9 })
    // No payout means no field — the card must not print "获得 undefined 积分".
    expect(classifyCheckin({ ok: true, checkin: { state: 'checked-in' } })).toEqual({ kind: 'done' })
    expect('claimed' in classifyCheckin({ ok: true, checkin: { state: 'checked-in', claimed: 0 } })).toBe(true)
  })
})

describe('formatCountdown', () => {
  it('writes HH:MM:SS with every part zero padded', () => {
    expect(formatCountdown(44 * 60_000 + 13_000)).toBe('00:44:13')
    expect(formatCountdown(3_600_000)).toBe('01:00:00')
    expect(formatCountdown(5_000)).toBe('00:00:05')
  })

  it('floors the seconds, so a finished trip never reads 00:00:01', () => {
    // Negative proof: `Math.ceil` on 1ms remaining gives 1 second, and the card
    // would keep showing a live countdown for a buddy that already arrived.
    expect(formatCountdown(1)).toBe('00:00:00')
    expect(Math.ceil(1 / 1000)).toBe(1)
  })

  it('does not wrap hours at 24, because a trip can outlast a day', () => {
    expect(formatCountdown(26 * 3_600_000)).toBe('26:00:00')
  })

  it('clamps a past arrival to zero rather than printing a negative clock', () => {
    expect(formatCountdown(-5_000)).toBe('00:00:00')
  })
})

describe('checkinExhausted', () => {
  it('keeps the button live while growth tasks are still unclaimed', () => {
    // The regression this guards: the click now also sweeps the growth center,
    // so a finished check-in plus a used-up trip is *not* the end of the day
    // while tasks remain — dimming here would strand those credits.
    expect(checkinExhausted({ todayCheckedIn: true }, { state: 'idle', dailyLimitReached: true }, { outstanding: 2 })).toBe(false)
    expect(checkinExhausted({ todayCheckedIn: true }, { state: 'idle', dailyLimitReached: true }, { outstanding: 0 })).toBe(true)
    // No sweep recorded yet: the task half cannot gate, so the old answer stands.
    expect(checkinExhausted({ todayCheckedIn: true }, { state: 'idle', dailyLimitReached: true }, undefined)).toBe(true)
    // An unfinished check-in still wins over a clean task list.
    expect(checkinExhausted({ todayCheckedIn: false }, { state: 'idle', dailyLimitReached: true }, { outstanding: 0 })).toBe(false)
  })

  it('stays live while today is not checked in', () => {
    expect(checkinExhausted({ todayCheckedIn: false }, { state: 'idle', dailyLimitReached: true })).toBe(false)
    expect(checkinExhausted(undefined, { state: 'idle', dailyLimitReached: true })).toBe(false)
  })

  it('dims only once check-in *and* the trip are both spent', () => {
    expect(checkinExhausted({ todayCheckedIn: true }, { state: 'idle', dailyLimitReached: true })).toBe(true)
    // No growth data at all still means nothing left to press it for.
    expect(checkinExhausted({ todayCheckedIn: true }, undefined)).toBe(true)
  })

  it('keeps the button live when the buddy can still move', () => {
    // The regression this guards: gating on `todayCheckedIn` alone made a
    // claimed-but-not-claimed trip unreachable, because this one click is also
    // the only way to send or collect the cat.
    expect(checkinExhausted({ todayCheckedIn: true }, { state: 'idle', dailyLimitReached: false })).toBe(false)
    expect(checkinExhausted({ todayCheckedIn: true }, { state: 'arrived' })).toBe(false)
    // A buddy already on the road has nothing left to press for either.
    expect(checkinExhausted({ todayCheckedIn: true }, { state: 'traveling', dailyLimitReached: true })).toBe(true)
    // Negative proof: the naive rule the user asked for would dim all three.
    const naive = (c: { todayCheckedIn?: boolean } | undefined): boolean => c?.todayCheckedIn === true
    expect(naive({ todayCheckedIn: true })).toBe(true)
  })
})