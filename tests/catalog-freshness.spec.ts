import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import {
  CATALOG_REFRESH_INTERVAL_MS,
  CATALOG_REFRESH_JITTER_MS,
  catalogRefreshDue,
  drawCatalogJitter,
  readCatalogSnapshot,
  workBuddyCatalogPath,
  writeCatalogSnapshot,
} from '../src/catalog-cache.ts'
import type { WorkBuddyUpstreamModel } from '../src/upstream.ts'

const cleanup: string[] = []

afterEach(async () => {
  while (cleanup.length > 0) {
    const path = cleanup.pop()
    if (path !== undefined) await rm(path, { recursive: true, force: true })
  }
})

/** The two ids a regression here must not lose: the flash model in daily use. */
const flash: WorkBuddyUpstreamModel = {
  id: 'deepseek-v4.1-flash',
  name: 'DeepSeek-V4.1-Flash',
  contextWindow: 128_000,
  maxTokens: 32_000,
  supportsImages: false,
  billing: { credits: 'x0.00', free: true },
}

const glm: WorkBuddyUpstreamModel = {
  id: 'glm-5.3',
  name: 'GLM 5.3',
  contextWindow: 200_000,
  maxTokens: 64_000,
  supportsImages: false,
  billing: { credits: 'x0.29', free: false },
}

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-catalog-'))
  cleanup.push(dir)
  return dir
}

describe('catalog snapshot', () => {
  it('round-trips the rows a restart needs to keep the picker populated', async () => {
    const dir = await directory()
    const path = workBuddyCatalogPath('cn', dir)
    writeCatalogSnapshot('cn', { fetchedAtMs: 1_700_000_000_000, models: [flash, glm] }, path)
    const snapshot = readCatalogSnapshot('cn', path)
    expect(snapshot?.fetchedAtMs).toBe(1_700_000_000_000)
    expect(snapshot?.models.map(model => model.id)).toEqual(['deepseek-v4.1-flash', 'glm-5.3'])
  })

  it('hydrates the picker before the network answers, without dropping the flash model', async () => {
    const dir = await directory()
    const path = workBuddyCatalogPath('cn', dir)
    writeCatalogSnapshot('cn', { fetchedAtMs: 1_700_000_000_000, models: [flash, glm] }, path)
    const catalog = new WorkBuddyCatalog({ scope: 'free' })
    const snapshot = readCatalogSnapshot('cn', path)
    expect(snapshot).toBeDefined()
    if (snapshot === undefined) return
    catalog.setUpstream(snapshot.models, snapshot.fetchedAtMs)
    // Free scope: the paid row is filtered out, the daily-use model survives, and
    // the first read of a process marks nothing as new.
    expect(catalog.current().map(model => model.id)).toEqual(['deepseek-v4.1-flash'])
    expect(catalog.newIds()).toEqual([])
    expect(catalog.fetchedAtMs()).toBe(1_700_000_000_000)
  })

  it('treats a missing, malformed, or half-shaped file as no cache at all', async () => {
    const dir = await directory()
    const missing = workBuddyCatalogPath('cn', dir)
    expect(readCatalogSnapshot('cn', missing)).toBeUndefined()

    const bad = join(dir, 'bad.json')
    await writeFile(bad, '{not json', 'utf8')
    expect(readCatalogSnapshot('cn', bad)).toBeUndefined()

    const wrongShape = join(dir, 'wrong.json')
    await writeFile(wrongShape, JSON.stringify({ schema: 1, fetchedAtMs: 1, models: [{ id: 'x' }] }), 'utf8')
    expect(readCatalogSnapshot('cn', wrongShape)).toBeUndefined()
  })

  it('writes through a temp file so a crash cannot leave a parsed-half document', async () => {
    const dir = await directory()
    const path = workBuddyCatalogPath('global', dir)
    writeCatalogSnapshot('global', { fetchedAtMs: 5, models: [flash] }, path)
    expect(readCatalogSnapshot('global', path)?.models.length).toBe(1)
    expect(readCatalogSnapshot('global', `${path}.tmp`)).toBeUndefined()
  })
})

describe('catalog refresh arithmetic', () => {
  it('is due at once when the region never answered', () => {
    expect(catalogRefreshDue(undefined, 1_700_000_000_000, 0)).toBe(true)
  })

  it('waits out the interval plus this process\'s jitter', () => {
    const fetchedAt = 1_700_000_000_000
    expect(catalogRefreshDue(fetchedAt, fetchedAt + CATALOG_REFRESH_INTERVAL_MS - 1, 0)).toBe(false)
    expect(catalogRefreshDue(fetchedAt, fetchedAt + CATALOG_REFRESH_INTERVAL_MS, 0)).toBe(true)
    expect(catalogRefreshDue(fetchedAt, fetchedAt + CATALOG_REFRESH_INTERVAL_MS, 60_000)).toBe(false)
    expect(catalogRefreshDue(fetchedAt, fetchedAt + CATALOG_REFRESH_INTERVAL_MS + 60_000, 60_000)).toBe(true)
  })

  it('draws a jitter inside the window', () => {
    expect(drawCatalogJitter(() => 0)).toBe(0)
    const maximum = drawCatalogJitter(() => 0.999_999)
    expect(maximum).toBeGreaterThan(0)
    expect(maximum).toBeLessThan(CATALOG_REFRESH_JITTER_MS)
  })
})

describe('catalog generation marks', () => {
  it('flags only ids that appeared since the previous read, for one generation', () => {
    const catalog = new WorkBuddyCatalog({ scope: 'all' })
    catalog.setUpstream([flash])
    expect(catalog.newIds()).toEqual([])

    catalog.setUpstream([flash, glm])
    expect(catalog.newIds()).toEqual(['glm-5.3'])

    // Another read with the same rows clears the marks: a chip must not outlive
    // the refresh that produced it.
    catalog.setUpstream([flash, glm])
    expect(catalog.newIds()).toEqual([])
  })

  it('reports every listed id for switch pruning, policy ignored', () => {
    const catalog = new WorkBuddyCatalog({ scope: 'free' })
    catalog.setUpstream([flash, glm], 42)
    expect(catalog.knownIds()).toEqual(['deepseek-v4.1-flash', 'glm-5.3'])
    expect(catalog.current().map(model => model.id)).toEqual(['deepseek-v4.1-flash'])
    expect(catalog.fetchedAtMs()).toBe(42)
  })
})
