/**
 * The model catalog's on-disk snapshot, and the arithmetic deciding when to
 * re-fetch it.
 *
 * Two problems, one module. The catalog lives in memory only, so a restart used
 * to leave the picker empty until the first network read landed; and the interval
 * bookkeeping needs to survive that same restart, or a user who restarts DSH
 * repeatedly would re-fetch the upstream catalog on every boot — the one behaviour
 * that actually looks like scraping from the other side.
 *
 * The snapshot is pure cache: a missing, unreadable, or malformed file degrades
 * to "fetch now", never to a failed start.
 *
 * @module dsh-workbuddy/catalog-cache
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/** Bumped whenever the document shape changes; a mismatch is treated as absent. */
const SNAPSHOT_SCHEMA = 1

/**
 * How long a fetched catalog stays authoritative. The upstream ships new models
 * on the order of days, so a day is fresh enough, and two `GET /v3/config` calls
 * a day (one per region) is indistinguishable from no traffic at all.
 */
export const CATALOG_REFRESH_INTERVAL_MS = 24 * 60 * 60_000

/**
 * Upper bound of the per-process random delay added to the interval. Without it
 * every install would hit the gateway at the same wall-clock time each day.
 */
export const CATALOG_REFRESH_JITTER_MS = 45 * 60_000

/** One region's persisted catalog. */
export interface WorkBuddyCatalogSnapshot {
  fetchedAtMs: number
  models: readonly WorkBuddyModelInfo[]
}

/** The snapshot file for one region, under `$DSH_HOME`. */
export function workBuddyCatalogPath(region: WorkBuddyRegion, home?: string): string {
  return join(home ?? resolveDshHome(), 'storages', 'dsh-workbuddy', `catalog-${region}.json`)
}

/** One row's shape check; a bad row drops the whole snapshot rather than half of it. */
function isRow(value: unknown): value is WorkBuddyModelInfo {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return typeof row['id'] === 'string' && row['id'] !== '' && typeof row['name'] === 'string'
}

/**
 * Read one region's snapshot.
 *
 * @returns the snapshot, or `undefined` when the file is missing, unreadable,
 * written by another schema, or holds a row that fails the shape check.
 */
export function readCatalogSnapshot(
  region: WorkBuddyRegion,
  path: string = workBuddyCatalogPath(region),
): WorkBuddyCatalogSnapshot | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const wrapped = parsed as Record<string, unknown>
    if (wrapped['schema'] !== SNAPSHOT_SCHEMA) return undefined
    const fetchedAtMs = wrapped['fetchedAtMs']
    if (typeof fetchedAtMs !== 'number' || !Number.isFinite(fetchedAtMs)) return undefined
    const models = wrapped['models']
    if (!Array.isArray(models) || !models.every(isRow)) return undefined
    return { fetchedAtMs, models: models as readonly WorkBuddyModelInfo[] }
  } catch {
    return undefined
  }
}

/**
 * Write one region's snapshot.
 *
 * Written through a sibling temp file so a crash mid-write cannot leave a
 * half-document that the next start would refuse to parse.
 */
export function writeCatalogSnapshot(
  region: WorkBuddyRegion,
  snapshot: WorkBuddyCatalogSnapshot,
  path: string = workBuddyCatalogPath(region),
): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(
    temporary,
    JSON.stringify({ schema: SNAPSHOT_SCHEMA, fetchedAtMs: snapshot.fetchedAtMs, models: snapshot.models }),
    'utf8',
  )
  try {
    renameSync(temporary, path)
  } catch (error: unknown) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temp file is best-effort cleanup; the real error is the rename.
    }
    throw error
  }
}

/**
 * Whether a region's rows are old enough to re-fetch.
 *
 * @param fetchedAtMs - when the rows last arrived, or `undefined` for never.
 * @param now - current epoch ms.
 * @param jitterMs - this process's random delay, added to the interval.
 */
export function catalogRefreshDue(
  fetchedAtMs: number | undefined,
  now: number,
  jitterMs: number,
): boolean {
  if (fetchedAtMs === undefined) return true
  return now - fetchedAtMs >= CATALOG_REFRESH_INTERVAL_MS + Math.max(0, jitterMs)
}

/** This process's random share of the jitter window. */
export function drawCatalogJitter(random: () => number = Math.random): number {
  return Math.floor(random() * CATALOG_REFRESH_JITTER_MS)
}
