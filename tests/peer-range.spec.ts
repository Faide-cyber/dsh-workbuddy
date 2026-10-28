import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { satisfies } from './semver-lite.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  engines: Record<string, string>
  peerDependencies: Record<string, string>
}

const DSH_RANGE = manifest.engines['dsh'] ?? ''
const DSH_PACKAGES = Object.keys(manifest.peerDependencies).filter(name =>
  name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))

describe('dsh version ranges', () => {
  it('declares the same range for engines.dsh and every dsh-* peer', () => {
    // The market's compatibility badge reads `engines.dsh`; DSH's loader reads the
    // peers. Two spellings of one contract would drift, so they are asserted equal.
    expect(DSH_PACKAGES.length).toBeGreaterThan(0)
    for (const name of DSH_PACKAGES) {
      expect(manifest.peerDependencies[name], name).toBe(DSH_RANGE)
    }
  })

  it('admits every 0.2.x release, prerelease or not', () => {
    for (const version of ['0.2.0-rc.2', '0.2.0', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1', '0.2.2', '0.2.9']) {
      expect(satisfies(version, DSH_RANGE), version).toBe(true)
    }
  })

  it('still refuses a version below the floor or past the 0.3 line', () => {
    for (const version of ['0.1.7', '0.2.0-rc.1', '0.3.0-rc.1', '0.3.0']) {
      expect(satisfies(version, DSH_RANGE), version).toBe(false)
    }
  })

  it('judges every version identically with and without includePrerelease', () => {
    // This is the regression the explicit `||` branch exists to prevent: `^0.2.0-rc.2`
    // admits 0.2.1-rc.3 only under DSH's includePrerelease gate, so plain `npm install`
    // resolved it as unsatisfiable and raised ERESOLVE.
    const naiveCaret = '^0.2.0-rc.2'
    expect(satisfies('0.2.1-rc.3', naiveCaret)).toBe(false)
    expect(satisfies('0.2.1-rc.3', naiveCaret, true)).toBe(true)

    const versions = ['0.1.7', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0', '0.2.1-rc.1', '0.2.1-rc.3', '0.2.1', '0.2.2', '0.2.9', '0.3.0-rc.1', '0.3.0']
    for (const version of versions) {
      expect(satisfies(version, DSH_RANGE), version)
        .toBe(satisfies(version, DSH_RANGE, true))
    }
  })
})

describe('pi-ai version range', () => {
  const range = (): string => manifest.peerDependencies['@earendil-works/pi-ai'] ?? ''

  it('admits both pi-ai generations the harness has shipped', () => {
    expect(satisfies('0.87.1', range())).toBe(true)
    expect(satisfies('1.1.0', range())).toBe(true)
    expect(satisfies('1.2.0', range())).toBe(true)
  })

  it('refuses a 2.x rework and anything below what the adapter was built on', () => {
    // A future 2.x reworks the provider surface this adapter constructs against.
    expect(satisfies('2.0.0-rc.1', range())).toBe(false)
    expect(satisfies('2.0.0', range())).toBe(false)
    expect(satisfies('0.86.0', range())).toBe(false)
  })
})

describe('peer declaration hygiene', () => {
  it('leaves no dsh-* peer pinned to a single exact version', () => {
    const exact = DSH_PACKAGES.filter(name => /^\d/u.test(manifest.peerDependencies[name] ?? ''))
    expect(exact).toEqual([])
  })

  it('never writes a bare caret over a prerelease floor', () => {
    // `^0.2.0-rc.2` is the trap; any `^x.y.z-pre` spelling here is a bug.
    const caretPrerelease = Object.entries(manifest.peerDependencies)
      .filter(([, value]) => /^[\^~]\d+\.\d+\.\d+-/u.test(value))
    expect(caretPrerelease).toEqual([])
  })
})
