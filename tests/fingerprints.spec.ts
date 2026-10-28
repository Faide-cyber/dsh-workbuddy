import { describe, expect, it } from 'vitest'
import { CONTENT_FINGERPRINTS, rewriteFingerprintsInContent, rewriteFingerprintsInText } from '../src/fingerprints.ts'

describe('CONTENT_FINGERPRINTS table', () => {
  it('documents live evidence for every entry', () => {
    expect(CONTENT_FINGERPRINTS.length).toBeGreaterThan(0)
    for (const rule of CONTENT_FINGERPRINTS) {
      // A run long enough to be specific, a genuinely different wording, and a note
      // that says when and how it was measured — the table's own rule.
      expect(rule.find.length).toBeGreaterThan(10)
      expect(rule.replace).not.toBe(rule.find)
      expect(rule.note).toMatch(/20\d\d-\d\d-\d\d/)
    }
  })

  it('removes every registered run, in any casing', () => {
    for (const rule of CONTENT_FINGERPRINTS) {
      for (const variant of [rule.find, rule.find.toUpperCase(), rule.find.toLowerCase()]) {
        const rewritten = rewriteFingerprintsInText(`prefix ${variant} suffix`)
        expect(rewritten.toLowerCase()).not.toContain(rule.find.toLowerCase())
        expect(rewritten).toContain(rule.replace)
      }
    }
  })

  it('does not leave another registered run behind', () => {
    for (const rule of CONTENT_FINGERPRINTS) {
      const rewritten = rewriteFingerprintsInText(rule.replace).toLowerCase()
      for (const other of CONTENT_FINGERPRINTS) {
        expect(rewritten).not.toContain(other.find.toLowerCase())
      }
    }
  })

  it('returns text without a known run as the very same string', () => {
    const plain = 'Nothing to see here. Plain prose, no fingerprint.'
    expect(rewriteFingerprintsInText(plain)).toBe(plain)
    expect(rewriteFingerprintsInContent(plain)).toBe(plain)
    const parts = [{ type: 'text', text: plain }, 'plain']
    expect(rewriteFingerprintsInContent(parts)).toBe(parts)
  })

  it('matches literally, never as a pattern', () => {
    // The registered run contains periods; one changed character must be enough to
    // miss, or the rewrite would quietly fire on unrelated prose.
    const near = 'Tokens prefixed with @ are paths the user explicitly referencedX Relative paths resolve to the workspace root'
    expect(rewriteFingerprintsInText(near)).toBe(near)
  })

  it('rewrites a text part and leaves other part shapes alone', () => {
    const out = rewriteFingerprintsInContent([
      { type: 'text', text: 'DeepSeek Harness docs' },
      { type: 'image_url', image_url: { url: 'http://example.com/x.png' } },
      { type: 'reasoning', text: 'DeepSeek Harness' },
    ]) as { text?: string }[]
    expect(out[0]?.text).toBe('DSH docs')
    expect(out[1]).toEqual({ type: 'image_url', image_url: { url: 'http://example.com/x.png' } })
    // A reasoning part carries its text in the same field, so the same walker covers it.
    expect(out[2]?.text).toBe('DSH')
  })

  it('is idempotent', () => {
    const once = rewriteFingerprintsInText(`x ${CONTENT_FINGERPRINTS[0]!.find} y`)
    expect(rewriteFingerprintsInText(once)).toBe(once)
  })
})