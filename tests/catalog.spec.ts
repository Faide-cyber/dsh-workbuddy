import { describe, expect, it } from 'vitest'
import { composeCatalog, WorkBuddyCatalog } from '../src/catalog.ts'
import type { WorkBuddyUpstreamModel } from '../src/upstream.ts'

const freeHy4Preview: WorkBuddyUpstreamModel = {
  id: 'hy4-preview',
  name: 'Hy4 preview',
  contextWindow: 1_000_000,
  maxTokens: 64_000,
  supportsImages: true,
  billing: { credits: 'x0.00', free: true },
}

const paidHy4Preview: WorkBuddyUpstreamModel = {
  ...freeHy4Preview,
  billing: { credits: 'x0.29', free: false },
}

const hy3: WorkBuddyUpstreamModel = {
  id: 'hy3',
  name: 'Hy3',
  contextWindow: 192_000,
  maxTokens: 64_000,
  supportsImages: true,
  billing: { credits: 'x0.00', free: true },
}

describe('composeCatalog', () => {
  it('serves nothing before the region answers', () => {
    expect(composeCatalog([], { scope: 'free' })).toEqual([])
    expect(composeCatalog([], { scope: 'all' })).toEqual([])
  })

  it('quotes the region\'s own credits, including a promotional x0.00', () => {
    // The catalog is the only price authority now: whatever the region publishes
    // is what the picker shows, even when a promotion has replaced a paid rate
    // with x0.00. No local table second-guesses it.
    const ids = composeCatalog([freeHy4Preview, paidHy4Preview, hy3], { scope: 'free' }).map(model => model.id)
    expect(ids).toEqual(['hy4-preview', 'hy3'])
  })

  it('lists paid models when the policy is all', () => {
    const rows = composeCatalog([paidHy4Preview, hy3], { scope: 'all' })
    expect(rows.map(model => model.id)).toEqual(['hy4-preview', 'hy3'])
    expect(rows.find(model => model.id === 'hy4-preview')?.billing?.credits).toBe('x0.29')
  })

  it('preserves upstream order and does not inject models the region omitted', () => {
    const rows = composeCatalog([paidHy4Preview, hy3], { scope: 'all' })
    expect(rows.map(model => model.id)).toEqual(['hy4-preview', 'hy3'])
    expect(rows.some(model => model.id === 'deepseek-v4.1-flash')).toBe(false)
  })

  it('defaults to the free policy', () => {
    expect(composeCatalog([freeHy4Preview, paidHy4Preview]).map(model => model.id)).toEqual(['hy4-preview'])
  })
})

describe('WorkBuddyCatalog', () => {
  it('is empty until a region-specific catalog arrives', () => {
    const catalog = new WorkBuddyCatalog()
    expect(catalog.current()).toEqual([])
    expect(catalog.freeIds()).toEqual([])
    catalog.setUpstream([hy3])
    expect(catalog.current().map(model => model.id)).toEqual(['hy3'])
  })

  it('keeps two regions independent', () => {
    const global = new WorkBuddyCatalog({ scope: 'all' })
    const cn = new WorkBuddyCatalog({ scope: 'all' })
    global.setUpstream([freeHy4Preview])
    cn.setUpstream([{ ...freeHy4Preview, billing: { credits: 'x0.12', free: false } }])
    expect(global.current()[0]?.billing?.credits).toBe('x0.00')
    expect(cn.current()[0]?.billing?.credits).toBe('x0.12')
    expect(global.freeIds()).toEqual(['hy4-preview'])
    expect(cn.freeIds()).toEqual([])
  })

  it('reports the free ids from the active region', () => {
    const catalog = new WorkBuddyCatalog({ scope: 'all' })
    catalog.setUpstream([freeHy4Preview, hy3])
    expect(catalog.freeIds()).toEqual(['hy4-preview', 'hy3'])
    expect(catalog.isFree('hy3')).toBe(true)
    expect(catalog.isFree('hy4-preview')).toBe(true)
    catalog.setScope('free')
    expect(catalog.current().map(model => model.id)).toEqual(['hy4-preview', 'hy3'])
  })
})

describe('per-model picker switches', () => {
  it('reports nothing disabled until the switches are touched', () => {
    const catalog = new WorkBuddyCatalog({ scope: 'all' })
    expect(catalog.disabledIds()).toEqual([])
    expect(catalog.isDisabled('hy3')).toBe(false)
  })

  it('tracks the disabled set without shrinking current(), which is what resolves a request', () => {
    const catalog = new WorkBuddyCatalog({ scope: 'all' })
    catalog.setUpstream([paidHy4Preview, hy3])
    catalog.setDisabled(['hy3'])
    expect(catalog.disabledIds()).toEqual(['hy3'])
    expect(catalog.isDisabled('hy3')).toBe(true)
    expect(catalog.isDisabled('hy4-preview')).toBe(false)
    // The negative proof that matters: `current()` is the list the pi-ai
    // snapshot and `resolveModel` read. If disabling also filtered it here, a
    // session already on `hy3` would break with UNKNOWN_MODEL instead of merely
    // losing the model from the picker.
    expect(catalog.current().map(model => model.id)).toContain('hy3')
  })

  it('replaces, never accumulates, the disabled set', () => {
    const catalog = new WorkBuddyCatalog()
    catalog.setDisabled(['a', 'b'])
    catalog.setDisabled(['b'])
    expect(catalog.disabledIds()).toEqual(['b'])
  })
})
