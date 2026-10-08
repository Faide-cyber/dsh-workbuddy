/**
 * The provider rows this plugin contributes to the Models settings page, kept in
 * step with what the user has actually signed in.
 *
 * The DSH model registry has no "hidden" state: a route is either registered —
 * and therefore listed — or absent. So "do not offer WorkBuddy before signing
 * in" can only mean "do not register it", and the row has to be added on sign-in
 * and withdrawn again on sign-out. Both halves of the row move together: an
 * adapter with no directory entry, or a directory entry with no adapter, renders
 * as a provider that cannot be used.
 *
 * @module dsh-workbuddy/provider-rows
 */

import type { WorkBuddyAdapter } from './adapter.ts'

/** One region's provider row. */
export interface ProviderRowSpec {
  /** Route id, e.g. `workbuddy-ai`. */
  provider: string
  /** Name shown in the Models list. */
  displayName: string
  /** Settings namespace owning the row's configuration. */
  settingsNs: string
  /** The adapter streaming calls for this route. */
  adapter: WorkBuddyAdapter['adapter']
}

/** The subset of the host `llm` service this needs; a fake is enough in tests. */
export interface ProviderRowRegistrar {
  registerAdapter(providers: string[], adapter: WorkBuddyAdapter['adapter']): () => void
  registerConfigurableProviders(entries: ReadonlyArray<{
    provider: string
    displayName: string
    settingsNs: string
    settingsPath: string[]
    declared: boolean
  }>): () => void
}

export interface ProviderRows {
  /** Register or release one region's row. Idempotent per region. */
  setLive(region: string, live: boolean): void
  /** Release every live row; called when the plugin's fiber goes away. */
  releaseAll(): void
  /** Regions whose row is currently registered. */
  liveRegions(): string[]
}

/**
 * Registration is all-or-nothing per region: if the directory entry is refused
 * after the adapter landed, the adapter is rolled back so the region cannot be
 * left half-registered and therefore listed but unusable.
 */
export function createProviderRows(
  registrar: ProviderRowRegistrar,
  specs: ReadonlyMap<string, ProviderRowSpec>,
): ProviderRows {
  const held = new Map<string, Array<() => void>>()

  const release = (region: string): void => {
    const releases = held.get(region)
    if (releases === undefined) return
    held.delete(region)
    for (const undo of [...releases].reverse()) undo()
  }

  return {
    setLive(region, live) {
      const spec = specs.get(region)
      if (spec === undefined) return
      if (!live) {
        release(region)
        return
      }
      if (held.has(region)) return
      const releases: Array<() => void> = []
      held.set(region, releases)
      try {
        releases.push(registrar.registerAdapter([spec.provider], spec.adapter))
        releases.push(registrar.registerConfigurableProviders([{
          provider: spec.provider,
          displayName: spec.displayName,
          settingsNs: spec.settingsNs,
          settingsPath: [],
          declared: false,
        }]))
      } catch (error: unknown) {
        release(region)
        throw error
      }
    },
    releaseAll() {
      for (const region of [...held.keys()]) release(region)
    },
    liveRegions() {
      return [...held.keys()]
    },
  }
}
