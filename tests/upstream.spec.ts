import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchGrowthRewardToday, fetchGrowthStatus, isFreeCredits, runGrowthTrip, WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

const credential: WorkBuddyCredential = {
  accessToken: 'test-access-token',
  refreshToken: '',
  expiresAtMs: Date.now() + 60_000,
  domain: 'www.codebuddy.cn',
  uid: 'test-user',
  source: 'dsh',
}

const envelope = (accounts: readonly Record<string, unknown>[]): Response => new Response(JSON.stringify({
  code: 0,
  data: { Response: { Data: { Accounts: accounts } } },
}), { status: 200, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fetchModels', () => {
  const model = (id: string, credits?: string): Record<string, unknown> => ({
    id,
    name: id,
    maxInputTokens: 128_000,
    maxOutputTokens: 8_192,
    ...credits === undefined ? {} : { credits },
  })
  const catalog = (models: readonly Record<string, unknown>[]): Response => new Response(JSON.stringify({
    code: 0,
    data: { models, agents: [{ name: 'cli', models: models.map(m => m.id) }] },
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  it('reads the domestic app catalog and falls back to the legacy roster', async () => {
    const seen: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      seen.push(url)
      if (url.includes('/v3/config')) {
        return catalog([model('hy4-preview-f', 'x0.00 credits'), model('hy3', 'x0.00 credits')])
      }
      throw new Error(`unexpected path: ${url}`)
    })

    const models = await new WorkBuddyUpstreamClient().fetchModels(credential)
    expect(seen).toEqual(['https://copilot.tencent.com/v3/config'])
    expect(models.map(m => m.id)).toEqual(['hy4-preview-f', 'hy3'])
    expect(models.every(m => m.billing?.free === true)).toBe(true)

    // Negative proof: the legacy roster is the paid price list under the same
    // display names. If the fallback ever becomes the first choice, the free
    // picker silently empties — this asserts the two are distinguishable.
    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      seen.push(url)
      if (url.includes('/v3/config')) return new Response('boom', { status: 500 })
      return catalog([model('hy4-preview', 'x0.29')])
    })
    seen.length = 0
    const fallback = await new WorkBuddyUpstreamClient().fetchModels(credential)
    expect(seen).toEqual([
      'https://copilot.tencent.com/v3/config',
      'https://copilot.tencent.com/console/enterprises/personal/models',
    ])
    expect(fallback.map(m => m.id)).toEqual(['hy4-preview'])
    expect(fallback.every(m => m.billing?.free === true)).toBe(false)
  })

  it('reads the international app catalog, which the legacy view truncates', async () => {
    const seen: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      seen.push(url)
      // The narrow legacy view: no deepseek-v4.1-flash, hy4-preview shows x0.00.
      if (url.includes('/v2/enterprises/personal/models')) {
        return catalog([model('hy4-preview', 'x0.00'), model('hy3', 'x0.00')])
      }
      return catalog([
        model('deepseek-v4.1-flash', 'x0.00'),
        model('hy4-preview', 'x0.29'),
        model('gpt-6-astra', 'x6.67'),
      ])
    })

    const models = await new WorkBuddyUpstreamClient()
      .fetchModels({ ...credential, domain: 'www.workbuddy.ai' })

    // The app catalog is the first choice in both regions; the legacy path is
    // only a fallback. Reading the legacy path alone hides a free model.
    expect(seen).toEqual(['https://www.workbuddy.ai/v3/config'])
    expect(models.map(m => m.id)).toEqual(['deepseek-v4.1-flash', 'hy4-preview', 'gpt-6-astra'])
    expect(models.find(m => m.id === 'deepseek-v4.1-flash')?.billing?.free).toBe(true)
    expect(models.find(m => m.id === 'hy4-preview')?.billing?.free).toBe(false)
  })
})

describe('isFreeCredits', () => {
  it('treats a zero multiplier as free whatever unit the upstream appends', () => {
    expect(isFreeCredits('x0.00 credits')).toBe(true)
    expect(isFreeCredits('x0.00')).toBe(true)
    expect(isFreeCredits('0')).toBe(true)
    // Negative proof: absence stays paid, and a nonzero multiplier is never free
    // even when it carries the trailing unit.
    expect(isFreeCredits(undefined)).toBe(false)
    expect(isFreeCredits('x0.29')).toBe(false)
    expect(isFreeCredits('x0.79 credits')).toBe(false)
  })
})

describe('fetchCredits', () => {
  it('uses cycle capacity only for monthly packages', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(envelope([
      { PackageName: 'monthly', CapacityType: 4, CycleCapacitySize: 350, CycleCapacityRemain: 200 },
      { PackageName: 'domestic quota', CapacityType: 1, CapacitySize: 2000, CapacityRemain: 1800, CycleCapacitySize: 350, CycleCapacityRemain: 12 },
    ]))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(credential)
    expect(credits.total).toBe(2000)
    expect(credits.accounts).toEqual([
      { packageName: 'monthly', size: 350, remain: 200, capacityType: 4 },
      { packageName: 'domestic quota', size: 2000, remain: 1800, capacityType: 1 },
    ])
  })

  it('reads the package end from CycleEndTime as Beijing wall time', async () => {
    // A fresh envelope per call: a Response body is single-use, and this test
    // deliberately calls fetchCredits more than once.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => envelope([
      { PackageName: 'monthly', CapacityType: 4, CycleCapacitySize: 350, CycleCapacityRemain: 200, CycleEndTime: '2026-10-31 23:59:59', ExpiredTime: '' },
      { PackageName: 'one-off', CapacityType: 1, CapacitySize: 2000, CapacityRemain: 1800 },
    ]))

    // 2026-10-31 23:59:59 Beijing is 15:59:59 UTC. The host runs at +08:00, where
    // a bare `new Date(string)` parse happens to land on the same instant, so
    // asserting once would not distinguish the shift from the naive read. Running
    // the same fixture under a zone that is *not* +08:00 is what makes it a guard:
    // the naive parse would answer differently per zone, this one does not.
    const original = process.env['TZ']
    const readUnder = async (zone: string): Promise<number | undefined> => {
      process.env['TZ'] = zone
      return (await new WorkBuddyUpstreamClient().fetchCredits(credential)).accounts[0]?.expiresAt
    }
    try {
      expect(await readUnder('UTC')).toBe(Date.UTC(2026, 9, 31, 15, 59, 59))
      expect(await readUnder('America/New_York')).toBe(Date.UTC(2026, 9, 31, 15, 59, 59))
      // Negative proof: a plain `new Date('2026-10-31 23:59:59')` — what the old
      // code would have used — is 23:59:59 UTC, eight hours late.
      expect(Date.UTC(2026, 9, 31, 15, 59, 59)).not.toBe(Date.UTC(2026, 9, 31, 23, 59, 59))
    } finally {
      process.env['TZ'] = original
    }

    // The field the upstream actually fills is empty; a parser reading only it
    // would drop the expiry entirely and render no 到期时间 at all.
    const credits = await new WorkBuddyUpstreamClient().fetchCredits(credential)
    expect(credits.accounts[1]?.expiresAt).toBeUndefined()
  })

  it('ignores an empty or malformed package end rather than showing epoch zero', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(envelope([
      { PackageName: 'blank', CapacityType: 1, CapacitySize: 10, CapacityRemain: 5, CycleEndTime: '' },
      { PackageName: 'junk', CapacityType: 1, CapacitySize: 10, CapacityRemain: 5, CycleEndTime: '31/10/2026' },
    ]))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(credential)
    expect(credits.accounts.every(account => account.expiresAt === undefined)).toBe(true)
  })
})

/**
 * Growth-plan ("小猫成长计划") state machine.
 *
 * Every case below is a way the card could be wrong on screen, so each one
 * asserts the CALL SEQUENCE too, not just the return value: an implementation
 * that dispatched on an unknown state, or claimed before checking whether
 * anything had arrived, passes on a single `reason` field but fails here.
 */
describe('growth trip', () => {
  const status = (data: Record<string, unknown>): Response => new Response(JSON.stringify({ code: 0, data }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
  // `msg`, not `message`: that is the field `readEnvelope` reads, and a fixture
  // using the wrong one would produce an error with an empty reason — which is
  // exactly the case the daily-limit guard has to match on.
  const failure = (msg: string, code = 400): Response => new Response(JSON.stringify({ code: 400_000 + code, msg }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })

  /** Records every request and answers `/status` from the scripted sequence. */
  const script = (responses: (Response | (() => Response))[]) => {
    const calls: string[] = []
    let index = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(`${init?.method ?? 'GET'} ${url.slice(url.indexOf('/activity/'))}`)
      const next = responses[index++]
      if (next === undefined) throw new Error(`unexpected extra call: ${url}`)
      return typeof next === 'function' ? next() : next
    })
    return calls
  }

  // A factory, not a value: a `Response` body is single-use, and these fixtures
  // are scripted into more than one call.
  const idle = () => status({ state: 'idle', daily_limit_reached: false })
  // `/config` is what publishes destination ids; `depart` needs one of them.
  const destinations = (...ids: number[]) => status({ locations: ids.map(id => ({ id })) })

  it('sends the buddy out when idle, and the path is not version-prefixed', async () => {
    // Negative proof baked in: `/v2/activity/growth/...` answers 401 upstream
    // because that prefix is registered against a different auth plugin, so the
    // assertion on the recorded path is the guard, not decoration.
    const calls = script([idle, destinations(1, 2), () => status({ state: 'traveling', record_id: 42 })])
    const result = await runGrowthTrip(credential)

    expect(result).toEqual({ dispatched: true })
    expect(calls[1]).toBe('GET /activity/growth/buddy/travel/config')
    expect(calls[2]).toBe('POST /activity/growth/buddy/travel/depart')
    expect(calls.some(call => call.includes('/v2/'))).toBe(false)
    // The regression this guards: `depart` with an empty body answers HTTP 400
    // `invalid request` upstream, so a body without a destination silently
    // dispatches nothing. Assert the id actually reaches the wire.
    expect(JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[2]?.[1]?.body))).toEqual({ location_id: 1 })
  })

  it('reports no-destination rather than departing without one', async () => {
    const calls = script([idle, () => status({ locations: [] })])
    expect(await runGrowthTrip(credential)).toEqual({ dispatched: false, reason: 'no-destination' })
    expect(calls).toEqual([
      'GET /activity/growth/buddy/travel/status',
      'GET /activity/growth/buddy/travel/config',
    ])
  })

  it('uses an explicit destination without reading the config', async () => {
    const calls = script([idle, () => status({ state: 'traveling' })])
    expect(await runGrowthTrip(credential, 7)).toEqual({ dispatched: true })
    expect(calls).toEqual([
      'GET /activity/growth/buddy/travel/status',
      'POST /activity/growth/buddy/travel/depart',
    ])
    expect(JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[1]?.[1]?.body))).toEqual({ location_id: 7 })
  })

  it('claims an arrived trip instead of dispatching a second one', async () => {
    const calls = script([
      status({ state: 'arrived', daily_limit_reached: true, record_id: 77, location: { name: '西湖' } }),
      status({ reward_credit: 5 }),
    ])
    const result = await runGrowthTrip(credential)

    expect(result).toEqual({ dispatched: false, claimed: 5 })
    // The record id must reach the claim body, or the upstream claims the
    // wrong (most recent) trip.
    expect(calls).toEqual([
      'GET /activity/growth/buddy/travel/status',
      'POST /activity/growth/buddy/travel/claim',
    ])
    expect(JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[1]?.[1]?.body))).toEqual({ record_id: 77 })
  })

  it('treats a missing reward as nothing to claim rather than an error', async () => {
    script([
      status({ state: 'arrived', record_id: 77 }),
      status({ reward_credit: 0 }),
    ])
    expect(await runGrowthTrip(credential)).toEqual({ dispatched: false, reason: 'nothing-to-claim' })
  })

  it('never dispatches from an unknown state, and never twice while traveling', async () => {
    // The dangerous bug this prevents: an unrecognised state treated as idle
    // would stack a second trip on top of one already in flight.
    const unknown = script([status({ state: 'on_holiday' })])
    expect(await runGrowthTrip(credential)).toEqual({ dispatched: false, reason: 'unknown-state' })
    expect(unknown).toHaveLength(1)

    const traveling = script([status({ state: 'traveling', record_id: 42 })])
    expect(await runGrowthTrip(credential)).toEqual({ dispatched: false, reason: 'traveling' })
    expect(traveling).toHaveLength(1)
  })

  it('reports the daily limit instead of dispatching, in both spellings', async () => {
    const blocked = script([status({ state: 'idle', daily_limit_reached: true })])
    expect(await runGrowthTrip(credential)).toEqual({ dispatched: false, reason: 'daily-limit' })

    // Upstream can also reject the dispatch itself when the limit is hit between
    // the status read and the depart call.
    const rejected = script([() => status({ state: 'idle', daily_limit_reached: false }), destinations(1), () => failure('Daily limit reached')])
    expect(await runGrowthTrip(credential)).toEqual({ dispatched: false, reason: 'daily-limit' })

    const raced = script([() => status({ state: 'idle', daily_limit_reached: false }), destinations(1), () => failure('already traveling')])
    expect(await runGrowthTrip(credential)).toEqual({ dispatched: false, reason: 'traveling' })
  })

  it('lets a genuine upstream failure through instead of swallowing it', async () => {
    script([idle, destinations(1), () => failure('Service unavailable')])
    await expect(runGrowthTrip(credential)).rejects.toThrow()
  })

  it('reads epoch seconds as milliseconds', async () => {
    script([() => status({ state: 'traveling', record_id: 9_001, arrive_at: 1_793_907_836, location: { name: '大理' } })])
    const growth = await fetchGrowthStatus(credential)

    // The doubling is the guard: read as milliseconds, 1793907836 is 1970-01-21,
    // which would render a trip that ended two months before the account existed.
    expect(growth.arriveAt).toBe(1_793_907_836_000)
    expect(growth.locationName).toBe('大理')
    // `record_id` is a plain id, never a timestamp — asserting it pins the fact
    // that the ×1000 is applied to `arrive_at` alone.
    expect(growth.recordId).toBe(9_001)
  })

  it('omits zero and missing optionals rather than rendering placeholders', async () => {
    script([status({ state: 'idle', daily_limit_reached: false })])
    const growth = await fetchGrowthStatus(credential)

    // `rewardCredit: 0` would make the card print "collect 0" on an idle buddy.
    expect('rewardCredit' in growth).toBe(false)
    expect('arriveAt' in growth).toBe(false)
    expect(growth.state).toBe('idle')
  })

  // `/status` answers `reward_credit: 0` for an idle buddy whether or not it was
  // paid, so the amount has to come from the trip log instead.
  const records = (entries: readonly Record<string, unknown>[]) => status({ records: entries })

  it('reads today\'s payout from the trip log, not from the idle status', async () => {
    const calls = script([records([
      { travel_date: '2026-10-06', claimed_at: 1_791_259_718, reward_credit: 7 },
      { travel_date: '2026-10-07', claimed_at: 1_791_312_739, reward_credit: 9 },
    ])])
    const reward = await fetchGrowthRewardToday(credential, '2026-10-07')

    expect(reward).toBe(9)
    expect(calls[0]).toBe('GET /activity/growth/buddy/travel/records')
  })

  it('separates "not yet claimed" from "paid zero"', async () => {
    // A record exists from the moment of departure, so `claimed_at: 0` means the
    // trip is still out — reporting it would print an amount nobody received.
    script([records([{ travel_date: '2026-10-07', claimed_at: 0, reward_credit: 9 }])])
    expect(await fetchGrowthRewardToday(credential, '2026-10-07')).toBeUndefined()

    script([records([{ travel_date: '2026-10-07', claimed_at: 1_791_312_739, reward_credit: 0 }])])
    expect(await fetchGrowthRewardToday(credential, '2026-10-07')).toBe(0)

    // Yesterday's payout must not be reported as today's.
    script([records([{ travel_date: '2026-10-06', claimed_at: 1_791_259_718, reward_credit: 7 }])])
    expect(await fetchGrowthRewardToday(credential, '2026-10-07')).toBeUndefined()
  })
})
