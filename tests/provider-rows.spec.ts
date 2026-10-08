import { describe, expect, it, vi } from 'vitest'
import { createProviderRows, type ProviderRowRegistrar, type ProviderRowSpec } from '../src/provider-rows.ts'
import type { WorkBuddyAdapter } from '../src/adapter.ts'

const adapter = {} as WorkBuddyAdapter['adapter']

const specs = new Map<string, ProviderRowSpec>([
  ['global', { provider: 'workbuddy-ai', displayName: 'WorkBuddy 国际版', settingsNs: 'workbuddy-ai', adapter }],
  ['cn', { provider: 'workbuddy-cn', displayName: 'WorkBuddy 国内版', settingsNs: 'workbuddy-ai', adapter }],
])

/** A registrar that records calls and can be made to fail on demand. */
function fakeRegistrar(failDirectory = false): ProviderRowRegistrar & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    registerAdapter(providers) {
      calls.push(`adapter:${providers.join(',')}`)
      return () => calls.push(`adapter-off:${providers.join(',')}`)
    },
    registerConfigurableProviders(entries) {
      if (failDirectory) throw new Error('DUPLICATE_DIRECTORY')
      calls.push(`directory:${entries.map(entry => entry.provider).join(',')}`)
      return () => calls.push(`directory-off:${entries.map(entry => entry.provider).join(',')}`)
    },
  }
}

describe('createProviderRows', () => {
  it('registers nothing until a region is signed in', () => {
    const registrar = fakeRegistrar()
    const rows = createProviderRows(registrar, specs)
    expect(rows.liveRegions()).toEqual([])
    expect(registrar.calls).toEqual([])
  })

  it('adds both halves of a row together and withdraws them in reverse', () => {
    const registrar = fakeRegistrar()
    const rows = createProviderRows(registrar, specs)
    rows.setLive('global', true)
    expect(registrar.calls).toEqual(['adapter:workbuddy-ai', 'directory:workbuddy-ai'])
    expect(rows.liveRegions()).toEqual(['global'])

    rows.setLive('global', false)
    expect(registrar.calls.slice(2)).toEqual(['directory-off:workbuddy-ai', 'adapter-off:workbuddy-ai'])
    expect(rows.liveRegions()).toEqual([])
  })

  it('is idempotent, so a repeated sign-in does not double-register', () => {
    const registrar = fakeRegistrar()
    const rows = createProviderRows(registrar, specs)
    rows.setLive('global', true)
    rows.setLive('global', true)
    rows.setLive('global', false)
    expect(registrar.calls).toEqual(['adapter:workbuddy-ai', 'directory:workbuddy-ai', 'directory-off:workbuddy-ai', 'adapter-off:workbuddy-ai'])
  })

  it('rolls the adapter back when the directory entry is refused', () => {
    // Orphaned adapter = a provider listed but unusable; the row must not survive
    // half-registered.
    const registrar = fakeRegistrar(true)
    const rows = createProviderRows(registrar, specs)
    expect(() => rows.setLive('global', true)).toThrow(/DUPLICATE_DIRECTORY/)
    expect(rows.liveRegions()).toEqual([])
    expect(registrar.calls).toEqual(['adapter:workbuddy-ai', 'adapter-off:workbuddy-ai'])
  })

  it('keeps regions independent and releaseAll clears every one', () => {
    const registrar = fakeRegistrar()
    const rows = createProviderRows(registrar, specs)
    rows.setLive('cn', true)
    rows.setLive('global', true)
    expect(rows.liveRegions()).toEqual(['cn', 'global'])
    rows.releaseAll()
    expect(rows.liveRegions()).toEqual([])
    expect(registrar.calls.filter(call => call.endsWith('-off:workbuddy-cn'))).toHaveLength(2)
  })

  it('ignores an unknown region', () => {
    const registrar = fakeRegistrar()
    const rows = createProviderRows(registrar, specs)
    rows.setLive('moon', true)
    expect(registrar.calls).toEqual([])
    expect(rows.liveRegions()).toEqual([])
  })
})
