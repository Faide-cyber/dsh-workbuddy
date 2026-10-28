/**
 * A minimal node-semver `satisfies`, inlined so the range assertions need no
 * dependency (`semver` is not a declared package here, and the peer ranges are
 * the one thing this suite cannot afford to guess at).
 *
 * It implements the parts the manifest actually uses — comparators, `||`
 * alternatives, caret/tilde expansion — plus the prerelease gate, which is the
 * whole reason `package.json` spells out an explicit `||` branch: without
 * `includePrerelease`, node-semver admits a prerelease version only when some
 * comparator shares its exact `major.minor.patch` tuple *and* carries its own
 * prerelease tag. `^0.2.0-rc.2` fails that test for `0.2.1-rc.3`, so plain
 * `npm install` saw the range as unsatisfiable and raised ERESOLVE, while DSH's
 * loader (which passes `includePrerelease`) admitted it.
 *
 * `tests/peer-range.spec.ts` asserts these verdicts; `.worktmp`-style ad-hoc
 * checks can diff them against the real `semver` package.
 */

export interface Version { major: number; minor: number; patch: number; pre: readonly string[] }

export function parseVersion(text: string): Version {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(text.trim())
  if (match === null) throw new Error(`unparseable version: ${text}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** Compare prerelease identifiers: numeric sorts below alphanumeric, shorter set below longer. */
function comparePre(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  // A version with no prerelease outranks one that has it.
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i]
    const right = b[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const leftNumeric = /^\d+$/u.test(left)
    const rightNumeric = /^\d+$/u.test(right)
    if (leftNumeric && rightNumeric) return Number(left) < Number(right) ? -1 : 1
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return left < right ? -1 : 1
  }
  return 0
}

export function compareVersions(a: Version, b: Version): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  return comparePre(a.pre, b.pre)
}

const sameTuple = (a: Version, b: Version): boolean =>
  a.major === b.major && a.minor === b.minor && a.patch === b.patch

interface Comparator { op: '' | '=' | '<' | '<=' | '>' | '>='; version: Version }

/**
 * The `<` bound a caret or tilde implies, as node-semver computes it.
 *
 * Caret breaks on the leftmost non-zero component (`^0.2.x` → `<0.3.0-0`, so a
 * 0.x caret spans a minor line); tilde always pins the minor. The `-0` suffix
 * matters: it makes the bound itself a prerelease, which is the spelling the
 * manifest must write to admit prerelease hosts.
 */
function impliedUpperBound(version: Version, kind: '^' | '~'): Version {
  const bound = (major: number, minor: number, patch: number): Version => ({ major, minor, patch, pre: ['0'] })
  if (kind === '~') return bound(version.major, version.minor + 1, 0)
  if (version.major > 0) return bound(version.major + 1, 0, 0)
  if (version.minor > 0) return bound(0, version.minor + 1, 0)
  return bound(0, 0, version.patch + 1)
}

/** Parse one `||` alternative into comparators, expanding `^`/`~` and `*`. */
function parseAlternative(alternative: string): Comparator[] | null {
  const trimmed = alternative.trim()
  // node-semver reads a wildcard as `>=0.0.0`, which is not the same as "always
  // true": it still carries the prerelease gate below, so `*` refuses a
  // prerelease host unless `includePrerelease` is set.
  if (trimmed === '' || trimmed === '*' || trimmed === 'x') {
    return [{ op: '>=', version: { major: 0, minor: 0, patch: 0, pre: [] } }]
  }
  const comparators: Comparator[] = []
  for (const raw of trimmed.split(/\s+/u).filter(Boolean)) {
    const match = /^(<=|>=|<|>|=|\^|~)?(.+)$/u.exec(raw)
    if (match === null) return null
    const op = match[1] ?? ''
    let version: Version
    try {
      version = parseVersion(match[2] as string)
    } catch {
      return null
    }
    if (op === '^' || op === '~') {
      comparators.push({ op: '>=', version })
      comparators.push({ op: '<', version: impliedUpperBound(version, op) })
      continue
    }
    comparators.push({ op: op as Comparator['op'], version })
  }
  return comparators.length === 0 ? null : comparators
}

function matchesComparator(version: Version, comparator: Comparator): boolean {
  const order = compareVersions(version, comparator.version)
  switch (comparator.op) {
    case '': case '=': return order === 0
    case '<': return order < 0
    case '<=': return order <= 0
    case '>': return order > 0
    case '>=': return order >= 0
  }
}

/**
 * node-semver's `satisfies`, including the prerelease gate described in the
 * module docblock.
 */
export function satisfies(versionText: string, range: string, includePrerelease = false): boolean {
  const version = parseVersion(versionText)
  for (const alternative of range.split('||')) {
    const comparators = parseAlternative(alternative)
    if (comparators === null) continue
    if (!comparators.every(comparator => matchesComparator(version, comparator))) continue
    if (!includePrerelease && version.pre.length > 0) {
      const admitted = comparators.some(comparator =>
        sameTuple(comparator.version, version) && comparator.version.pre.length > 0)
      if (!admitted) continue
    }
    return true
  }
  return false
}
