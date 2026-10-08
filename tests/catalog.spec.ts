import { describe, expect, it } from 'vitest'
import { composeCatalog, WorkBuddyCatalog } from '../src/catalog.ts'
import { BUILTIN_FREE_MODELS, parseProductConfig } from '../src/product-config.ts'
import type { WorkBuddyUpstreamModel } from '../src/upstream.ts'

const paidHy4Preview: WorkBuddyUpstreamModel = {
  id: 'hy4-preview',
  name: 'Hy4 preview',
  contextWindow: 1_000_000,
  maxTokens: 64_000,
  supportsImages: true,
  billing: { credits: 'x0.00', free: true },
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
  it('serves the three built-in free models before any upstream answer', () => {
    const ids = composeCatalog([], {
      productConfig: { source: 'builtin', models: [] },
      scope: 'free',
    }).map(model => model.id)
    expect(ids).toEqual(['deepseek-v4.1-flash', 'hy4-preview-f', 'hy3'])
  })

  it('does not treat the catalog\'s x0.00 on hy4-preview as free when the product config prices it x0.29', () => {
    const productConfig = parseProductConfig(JSON.stringify({
      models: [
        { id: 'hy4-preview', name: 'Hy4 preview', credits: 'x0.29', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: true },
        { id: 'hy4-preview-f', name: 'Hy4 preview', credits: 'x0.00', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: true },
        { id: 'hy3', name: 'Hy3', credits: 'x0.00', maxInputTokens: 192_000, maxOutputTokens: 64_000, supportsImages: true },
        { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.00', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, supportsImages: true },
      ],
    }))
    expect(productConfig).toBeDefined()
    const ids = composeCatalog([paidHy4Preview, hy3], {
      productConfig: productConfig!,
      scope: 'free',
    }).map(model => model.id)
    expect(ids).toContain('deepseek-v4.1-flash')
    expect(ids).toContain('hy4-preview-f')
    expect(ids).toContain('hy3')
    expect(ids).not.toContain('hy4-preview')
  })

  it('lists paid models when the policy is all', () => {
    const productConfig = parseProductConfig(JSON.stringify({
      models: [
        { id: 'hy4-preview', name: 'Hy4 preview', credits: 'x0.29', maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
        { id: 'hy3', name: 'Hy3', credits: 'x0.00', maxInputTokens: 192_000, maxOutputTokens: 64_000 },
      ],
    }))
    const ids = composeCatalog([paidHy4Preview, hy3], {
      productConfig: productConfig!,
      scope: 'all',
    }).map(model => model.id)
    expect(ids).toContain('hy4-preview')
    expect(ids).toContain('hy3')
  })

  it('injects built-in DeepSeek when a live catalog omits it and the app cache is gone', () => {
    const ids = composeCatalog([paidHy4Preview, hy3], {
      productConfig: { source: 'builtin', models: [] },
      scope: 'free',
    }).map(model => model.id)
    expect(ids).toContain('deepseek-v4.1-flash')
    expect(ids).toContain('hy4-preview-f')
    expect(ids).toContain('hy3')
    expect(ids).not.toContain('hy4-preview')
  })

  it('stamps built-in rates so free/paid lists follow x0.00 vs paid', () => {
    const free = composeCatalog([paidHy4Preview, hy3], {
      productConfig: { source: 'builtin', models: [] },
      scope: 'free',
    })
    expect(free.find(model => model.id === 'deepseek-v4.1-flash')?.billing?.credits).toBe('x0.00')
    expect(free.find(model => model.id === 'hy3')?.billing?.credits).toBe('x0.00')
    expect(free.some(model => model.id === 'hy4-preview')).toBe(false)

    const all = composeCatalog([paidHy4Preview, hy3], {
      productConfig: { source: 'builtin', models: [] },
      scope: 'all',
    })
    expect(all.find(model => model.id === 'hy4-preview')?.billing?.credits).toBe('x0.29')
    expect(all.find(model => model.id === 'hy4-preview')?.billing?.free).toBe(false)
    expect(all.find(model => model.id === 'deepseek-v4.1-flash')?.billing?.free).toBe(true)
  })

  it('keeps the built-in free whitelist as a safety net', () => {
    expect(BUILTIN_FREE_MODELS.map(model => model.id)).toEqual([
      'deepseek-v4.1-flash',
      'hy4-preview-f',
      'hy3',
    ])
  })

  it('can hide the fallback until a region-specific catalog arrives', () => {
    const catalog = new WorkBuddyCatalog({
      productConfig: { source: 'builtin', models: [] },
      fallback: false,
    })
    expect(catalog.current()).toEqual([])
    catalog.setUpstream([hy3])
    expect(catalog.current().map(model => model.id)).toContain('hy3')
  })

  it('keeps domestic upstream rates independent from global product rates', () => {
    const domestic = { ...paidHy4Preview, billing: { credits: 'x0.12', free: false } }
    const cn = composeCatalog([domestic], {
      productConfig: parseProductConfig(JSON.stringify({ models: [{ id: 'hy4-preview', name: 'Hy4 preview', credits: 'x0.29' }] }))!,
      scope: 'all',
      priceAuthority: 'upstream',
    })
    expect(cn[0]?.billing?.credits).toBe('x0.12')
    expect(cn[0]?.billing?.free).toBe(false)
  })
})

describe('per-model picker switches', () => {
  it('reports nothing disabled until the switches are touched', () => {
    const catalog = new WorkBuddyCatalog({ productConfig: { source: 'builtin', models: [] }, scope: 'all' })
    expect(catalog.disabledIds()).toEqual([])
    expect(catalog.isDisabled('hy3')).toBe(false)
  })

  it('tracks the disabled set without shrinking current(), which is what resolves a request', () => {
    const catalog = new WorkBuddyCatalog({ productConfig: { source: 'builtin', models: [] }, scope: 'all' })
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
    const catalog = new WorkBuddyCatalog({ productConfig: { source: 'builtin', models: [] } })
    catalog.setDisabled(['a', 'b'])
    catalog.setDisabled(['b'])
    expect(catalog.disabledIds()).toEqual(['b'])
  })
})
