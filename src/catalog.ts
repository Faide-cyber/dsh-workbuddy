/**
 * The plugin's model catalog: what the DSH model picker is offered, and under
 * which billing policy.
 *
 * Two inputs meet here, in a strict order of authority:
 *
 * 1. **The region's upstream catalog** — which models exist, their capacities,
 *    image support, declared reasoning efforts, and their `credits` price.
 * 2. **The billing policy** ({@link WorkBuddyCatalogOptions.scope}) — which of
 *    those the picker is allowed to show.
 *
 * The upstream catalog is the *only* authority on price: whatever the region
 * currently quotes in `credits` is what the picker shows, so a price change or
 * a new model reaches users without a plugin release. Earlier versions kept a
 * local price table and let it override the catalog; that table is gone, and
 * with it the risk of quoting yesterday's prices.
 *
 * @module dsh-workbuddy/catalog
 */

import type { WorkBuddyUpstreamModel } from './upstream.ts'
import { normalizeCredits } from './upstream.ts'

/** One model entry the adapter exposes. */
export type WorkBuddyModelInfo = WorkBuddyUpstreamModel

/** How the catalog decides which models the picker may show. */
export type WorkBuddyModelScope = 'free' | 'all'

/** Constructor dependencies for {@link WorkBuddyCatalog}. */
export interface WorkBuddyCatalogOptions {
  /** Which models the picker may show; see {@link WorkBuddyModelScope}. */
  scope?: WorkBuddyModelScope
}

/**
 * Apply the billing policy to the region's upstream rows.
 *
 * The filter runs last and only over the rows the region actually returned: an
 * empty upstream yields an empty list, deliberately. A region with no answer
 * yet must not borrow another region's models, or a sign-in to one deployment
 * would advertise the other's lineup.
 *
 * @param upstream - rows from the live catalog; empty before the first fetch.
 * @param options - the active billing policy.
 * @returns the effective model list, upstream order preserved.
 */
export function composeCatalog(
  upstream: readonly WorkBuddyModelInfo[],
  options: WorkBuddyCatalogOptions = {},
): readonly WorkBuddyModelInfo[] {
  const { scope = 'free' } = options
  if (scope === 'all') return [...upstream]
  return upstream.filter(model => model.billing?.free === true)
}

/**
 * The plugin's live catalog.
 *
 * `scope` is mutable because the settings card can flip between "free only" and
 * "all models" without a restart; the adapter rebuilds its snapshot from
 * {@link current} on every read, so a change lands on the next request.
 */
export class WorkBuddyCatalog {
  private upstream: readonly WorkBuddyModelInfo[] = []
  private scope: WorkBuddyModelScope
  /**
   * Models the user switched off in the card. Kept here rather than folded into
   * `scope` because the two answer different questions: the scope decides which
   * models are *offered*, this decides which of the offered ones the picker still
   * *lists*. Absent ids are enabled, so an install that never touched the
   * switches behaves exactly as before.
   */
  private disabled = new Set<string>()

  constructor(options: WorkBuddyCatalogOptions = {}) {
    this.scope = options.scope ?? 'free'
  }

  /** Replace the upstream rows; the effective list is recomposed immediately. */
  setUpstream(models: readonly WorkBuddyModelInfo[]): void {
    this.upstream = [...models]
  }

  /** The upstream rows as last received, before any policy is applied. */
  upstreamModels(): readonly WorkBuddyModelInfo[] {
    return this.upstream
  }

  /** Switch the billing policy; takes effect on the next {@link current} read. */
  setScope(scope: WorkBuddyModelScope): void {
    this.scope = scope
  }

  /**
   * Replace the set of models the picker must not list.
   *
   * This never touches {@link current}: the pi-ai snapshot that resolves a
   * request is built from it, so dropping a model here would turn a switched-off
   * model into `UNKNOWN_MODEL` for a session that had already selected it. The
   * filter is applied one layer up, in the adapter's `listModels`, which is what
   * the picker reads and the request path does not.
   */
  setDisabled(ids: readonly string[]): void {
    this.disabled = new Set(ids)
  }

  /** The ids the picker must not list. */
  disabledIds(): readonly string[] {
    return [...this.disabled]
  }

  /** Whether one model is switched off. */
  isDisabled(id: string): boolean {
    return this.disabled.has(id)
  }

  /** The active billing policy. */
  currentScope(): WorkBuddyModelScope {
    return this.scope
  }

  /** The effective entries; empty until the region's catalog arrives. */
  current(): readonly WorkBuddyModelInfo[] {
    return composeCatalog(this.upstream, { scope: this.scope })
  }

  /** Every model in this region, before the free/all picker policy is applied. */
  all(): readonly WorkBuddyModelInfo[] {
    return composeCatalog(this.upstream, { scope: 'all' })
  }

  /** Every model id this region prices as free. */
  freeIds(): readonly string[] {
    return this.all().filter(model => model.billing?.free === true).map(model => model.id)
  }

  /** Whether a model is free according to this region's authority. */
  isFree(id: string): boolean {
    return this.freeIds().includes(id)
  }

  /** Display suffix for one row: the rate, then any promotional badges. */
  displaySuffix(id: string): string | undefined {
    const model = this.current().find(entry => entry.id === id)
    if (model === undefined) return undefined
    const parts = [
      normalizeCredits(model.billing?.credits),
      ...(model.billing?.badges ?? []),
    ].filter((part): part is string => part !== undefined && part !== '')
    return parts.length === 0 ? undefined : parts.join(' · ')
  }
}
