/**
 * The plugin's model catalog: what the DSH model picker is offered, and under
 * which billing policy.
 *
 * Three inputs meet here, in a strict order of authority:
 *
 * 1. **The upstream catalog** (`/v2/enterprises/personal/models`) — which models
 *    exist, their capacities, image support, and declared reasoning efforts.
 * 2. **The product configuration** (`product-config.ts`) — what each model
 *    costs, and the full rows for the models the catalog endpoint omits.
 * 3. **The billing policy** ({@link WorkBuddyCatalogOptions.freeOnly}) — which
 *    of those the picker is allowed to show.
 *
 * The product configuration outranks the catalog on price specifically because
 * the catalog was measured wrong about it: it lists `hy4-preview` as `x0.00`
 * while the app prices it `x0.29`.
 *
 * @module dsh-workbuddy/catalog
 */

import type { WorkBuddyUpstreamModel } from './upstream.ts'
import { normalizeCredits } from './upstream.ts'
import type { WorkBuddyProductConfig } from './product-config.ts'
import { BUILTIN_CREDITS, BUILTIN_FREE_MODELS, freeModelIds, productModelById, productModelToCatalogRow } from './product-config.ts'

/** One model entry the adapter exposes. */
export type WorkBuddyModelInfo = WorkBuddyUpstreamModel

/** How the catalog decides which models the picker may show. */
export type WorkBuddyModelScope = 'free' | 'all'

/**
 * Static rows served before the first upstream answer arrives, and whenever the
 * upstream is unreachable.
 *
 * These are the two free models the international deployment does not list in
 * its catalog endpoint, plus `hy3` which it does. Serving a usable list from the
 * first moment means an offline upstream never leaves the provider empty.
 */
export const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[] = BUILTIN_FREE_MODELS

/** Constructor dependencies for {@link WorkBuddyCatalog}. */
export interface WorkBuddyCatalogOptions {
  /** Product configuration supplying prices and the omitted-model rows. */
  productConfig: WorkBuddyProductConfig
  /** Which models the picker may show; see {@link WorkBuddyModelScope}. */
  scope?: WorkBuddyModelScope
  /** Keep the legacy static fallback; false prevents a region leaking another region's list. */
  fallback?: boolean
  /** Use each region's upstream billing instead of the global product cache. */
  priceAuthority?: 'product' | 'upstream'
}

/**
 * Merge the upstream catalog with the product configuration under one billing
 * policy.
 *
 * Order of operations, each step deliberate:
 *
 * 1. Start from the upstream rows (or the fallback when there are none yet).
 * 2. Add product-config rows for free models the upstream omitted — this is what
 *    brings `deepseek-v4.1-flash` and `hy4-preview-f` into the picker.
 * 3. Overwrite each row's billing with the product configuration's verdict when
 *    it has one, so the catalog's wrong `x0.00` on a paid model cannot survive.
 * 4. Drop everything outside the policy's allow-list, *last*, so no later step
 *    can reintroduce a model the policy excluded.
 *
 * @param upstream - rows from the live catalog; empty before the first fetch.
 * @param options - product configuration and the active billing policy.
 * @returns the effective model list, upstream order first.
 */
export function composeCatalog(
  upstream: readonly WorkBuddyModelInfo[],
  options: WorkBuddyCatalogOptions,
): readonly WorkBuddyModelInfo[] {
  const { productConfig, scope = 'free', priceAuthority = 'product' } = options
  const free = priceAuthority === 'upstream'
    ? new Set(upstream.filter(model => model.billing?.free === true).map(model => model.id))
    : new Set(freeModelIds(productConfig))
  const byId = new Map<string, WorkBuddyModelInfo>()

  const source = upstream.length > 0 ? upstream : FALLBACK_WORKBUDDY_MODELS
  for (const model of source) byId.set(model.id, model)

  if (priceAuthority === 'product') {
    // Step 2: models the catalog endpoint omits (`deepseek-v4.1-flash`,
    // `hy4-preview-f`). Prefer a product-config row when the app cache is
    // present; otherwise inject the built-in free table.
    for (const id of free) {
      if (byId.has(id)) continue
      if (productConfig.source === 'cache') {
        const row = productModelById(productConfig, id)
        const built = row === undefined ? undefined : productModelToCatalogRow(row)
        if (built !== undefined) {
          byId.set(built.id, built)
          continue
        }
      }
      const builtin = BUILTIN_FREE_MODELS.find(model => model.id === id)
      if (builtin !== undefined) byId.set(id, builtin)
    }

    // Step 3: price authority is the product cache, then the built-in rate
    // table. Catalog `x0.00` is not trusted for the international deployment.
    for (const [id, model] of byId) {
      const row = productModelById(productConfig, id)
      const credits = row?.credits ?? BUILTIN_CREDITS[id]
      if (credits === undefined && row === undefined) continue
      byId.set(id, {
        ...model,
        billing: {
          ...model.billing,
          ...credits === undefined ? {} : { credits },
          free: free.has(id),
        },
      })
    }
  }

  // Step 4: apply the policy last.
  const allowed = scope === 'all' ? [...byId.values()] : [...byId.values()].filter(model => free.has(model.id))
  return allowed
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
  private readonly productConfig: WorkBuddyProductConfig
  private readonly fallback: boolean
  private readonly priceAuthority: 'product' | 'upstream'
  /**
   * Models the user switched off in the card. Kept here rather than folded into
   * `scope` because the two answer different questions: the scope decides which
   * models are *offered*, this decides which of the offered ones the picker still
   * *lists*. Absent ids are enabled, so an install that never touched the
   * switches behaves exactly as before.
   */
  private disabled = new Set<string>()

  constructor(options: WorkBuddyCatalogOptions) {
    this.productConfig = options.productConfig
    this.scope = options.scope ?? 'free'
    this.fallback = options.fallback ?? true
    this.priceAuthority = options.priceAuthority ?? 'product'
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

  /** The product configuration this catalog prices against. */
  product(): WorkBuddyProductConfig {
    return this.productConfig
  }

  /** The effective entries; the fallback list until the upstream answer lands. */
  current(): readonly WorkBuddyModelInfo[] {
    if (!this.fallback && this.upstream.length === 0) return []
    return composeCatalog(this.upstream, { productConfig: this.productConfig, scope: this.scope, priceAuthority: this.priceAuthority })
  }

  /** Every model in this region, before the free/all picker policy is applied. */
  all(): readonly WorkBuddyModelInfo[] {
    if (!this.fallback && this.upstream.length === 0) return []
    return composeCatalog(this.upstream, { productConfig: this.productConfig, scope: 'all', priceAuthority: this.priceAuthority })
  }

  /** Whether this region trusts upstream model billing instead of global product data. */
  usesUpstreamPricing(): boolean {
    return this.priceAuthority === 'upstream'
  }

  /** Every model id this region prices as free. */
  freeIds(): readonly string[] {
    if (this.priceAuthority === 'upstream') return this.all().filter(model => model.billing?.free === true).map(model => model.id)
    return freeModelIds(this.productConfig)
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
