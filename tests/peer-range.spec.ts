import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  peerDependencies: Record<string, string>
}

/**
 * A semver `satisfies` that expands `^`/`~` itself, so this test needs no
 * dependency. Prerelease-aware, matching how DSH evaluates the range
 * (`semver.satisfies(version, range, { includePrerelease: true })`).
 */
function satisfies(version: string, range: string): boolean {
  const parse = (text: string): { major: number; minor: number; patch: number; pre: string } => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/u.exec(text.trim())
    if (match === null) throw new Error(`unparseable version: ${text}`)
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? '' }
  }
  const compare = (a: string, b: string): number => {
    const left = parse(a)
    const right = parse(b)
    for (const key of ['major', 'minor', 'patch'] as const) {
      if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
    }
    // A prerelease sorts below its release.
    if (left.pre === right.pre) return 0
    if (left.pre === '') return 1
    if (right.pre === '') return -1
    return left.pre < right.pre ? -1 : 1
  }

  for (const alternative of range.split('||').map(part => part.trim())) {
    if (alternative === '' || alternative === '*') return true
    const lower = alternative.replace(/^[\^~]/u, '')
    if (compare(version, lower) < 0) continue
    const base = parse(lower)
    if (alternative.startsWith('^')) {
      // The abbreviated prerelease form `^0.2.0-rc.2` pins the minor, same as `~`.
      if (base.major === 0) {
        if (base.minor !== parse(version).minor) continue
        if (parse(version).major !== 0) continue
        return true
      }
      if (parse(version).major !== base.major) continue
      return true
    }
    if (alternative.startsWith('~')) {
      if (parse(version).major !== base.major || parse(version).minor !== base.minor) continue
      return true
    }
    if (compare(version, alternative) === 0) return true
  }
  return false
}

describe('peerDependencies range', () => {
  it('admits the 0.2.1 release line, not just 0.2.0-rc.2', () => {
    // The exact pins this used to carry made DSH 0.2.1-rc.2 refuse to load the
    // plugin at all, even though every one of these packages stays API-compatible.
    for (const version of ['0.2.0-rc.2', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.4', '0.2.2']) {
      expect(satisfies(version, manifest.peerDependencies['@deepseek-ai/dsh-llm'] ?? '')).toBe(true)
    }
    // Still bounded: a breaking 0.3 line must be reviewed rather than admitted.
    expect(satisfies('0.3.0', manifest.peerDependencies['@deepseek-ai/dsh-llm'] ?? '')).toBe(false)
    expect(satisfies('0.1.7', manifest.peerDependencies['@deepseek-ai/dsh-llm'] ?? '')).toBe(false)
  })

  it('admits both pi-ai generations the harness has shipped', () => {
    const range = manifest.peerDependencies['@earendil-works/pi-ai'] ?? ''
    expect(satisfies('0.87.1', range)).toBe(true)
    expect(satisfies('1.1.0', range)).toBe(true)
    expect(satisfies('1.2.0', range)).toBe(true)
    // A future 2.x reworks the provider surface the adapter builds against.
    expect(satisfies('2.0.0', range)).toBe(false)
    expect(satisfies('0.86.0', range)).toBe(false)
  })

  it('leaves no dsh-* peer pinned to a single exact version', () => {
    const exact = Object.entries(manifest.peerDependencies)
      .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
      .filter(([, range]) => /^\d/u.test(range))
    expect(exact).toEqual([])
  })
})
