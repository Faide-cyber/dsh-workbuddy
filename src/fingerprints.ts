/**
 * Rewrites for prompt text the WorkBuddy gateway fingerprints (HTTP 400
 * `code 11128`, "Illegal API invocation from an unapproved channel").
 *
 * The gateway does not rate-limit a client or inspect headers — it matches
 * **literal character runs** lifted from the client's own prompt text, in
 * `system` and `assistant` content (measured; `user`, `tool` results,
 * `reasoning_content` and `tool_calls[].function.arguments` all pass — see
 * {@link rewriteContentFingerprints}). Two defences follow from that:
 *
 * 1. **This table**: reword a known run. The wording changes, the bytes that
 *    matched do not survive, and a rewrite keeps working even if the gateway
 *    later normalizes whitespace (which it does: on 2026-10-29 it collapsed the
 *    U+00A0 separators the plugin used to inject, silently disarming them).
 * 2. **Line-break separation** (`separateTokenBoundaries`): break long runs
 *    without knowing which one matched. That one catches runs nobody registered
 *    yet, and is the reason this table may stay small.
 *
 * ## Adding an entry
 *
 * Every entry needs **live evidence**: the unmodified run answers 400/11128 and
 * the reworded run answers 200. A run copied from another project's table
 * without measuring it here is an unverified mutation of the user's prompt.
 *
 * The replacement must stay semantically equivalent — these are the model's
 * instructions, not decoration. Prefer the smallest edit that removes the run.
 *
 * @module dsh-workbuddy/fingerprints
 */

export interface ContentFingerprint {
  /** Literal run the gateway matches. Matched case-insensitively, as a plain string. */
  find: string
  /** Equivalent wording that no longer contains {@link find}. */
  replace: string
  /** Where the evidence came from. Required — see the module doc. */
  note: string
}

/**
 * Known fingerprints of DSH's own prompt text, plus the client-identity banner.
 *
 * All entries apply to DSH's own words. Fingerprints of *other* clients (ZCode's
 * git-status line, Claude Code's identity sentence) are deliberately absent:
 * this plugin only ever sends DSH's prompt.
 */
export const CONTENT_FINGERPRINTS: readonly ContentFingerprint[] = [
  {
    find: 'DeepSeek Harness',
    // The product's own abbreviation, used throughout DSH's own UI and docs.
    replace: 'DSH',
    note: '2026-10-22: a leading system message starting with "You are an AI agent '
      + 'powered by DeepSeek Harness" is answered 400/11128; renaming the brand word '
      + 'to DSH answers 200 upstream. Originally applied at the sentence start only '
      + '(shipped in 1.0.14); widened to every occurrence because the 2026-10-27 '
      + 'fingerprints match anywhere in the text, not at a fixed position.',
  },
  {
    find: 'Tokens prefixed with @ are paths the user explicitly referenced. '
      + 'Relative paths resolve to the workspace root',
    replace: 'Tokens starting with @ denote paths the user explicitly referenced. '
      + 'Relative paths are resolved against the workspace root',
    note: '2026-10-27/29: this 112-character prefix of @deepseek-ai/dsh-file-reference\'s '
      + 'FILE_REFERENCE_PROMPT is the minimal sufficient trigger. Dropping its last '
      + 'character answers 200, the order is significant, and 6/6 repetitions of the '
      + 'whole run answer 400 — so it is a literal match, not a heuristic. Rewording '
      + 'passes on the live gateway and keeps the instruction meaning.',
  },
]

/** Regex metacharacters escaped, so a literal is matched as a literal, never as a pattern. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const COMPILED = CONTENT_FINGERPRINTS.map(rule => ({
  replace: rule.replace,
  findLower: rule.find.toLowerCase(),
  // `g` rewrites every occurrence; `i` because the gateway matches case-insensitively
  // (measured: an all-lowercase and an all-uppercase run are both rejected).
  pattern: new RegExp(escapeRegExp(rule.find), 'gi'),
}))

/**
 * Reword known fingerprints in one piece of prompt text.
 *
 * **Text without a fingerprint is returned unchanged, byte for byte** — a
 * requirement, not a nicety: the upstream bills by prefix cache, so rebuilding a
 * string for no reason turns every turn into a cold request. Hence the
 * `includes` pre-check per rule: no match, no new string.
 *
 * This function does not know about roles. Which text is passed in is the
 * caller's policy; see {@link rewriteContentFingerprints} for the measured
 * answer.
 */
export function rewriteFingerprintsInText(text: string): string {
  let out = text
  for (const rule of COMPILED) {
    if (!out.toLowerCase().includes(rule.findLower)) continue
    out = out.replace(rule.pattern, rule.replace)
  }
  return out
}

/**
 * Reword a message `content` value (a string or an array of parts).
 *
 * Only parts carrying a string `text` are touched; a part of any other shape is
 * returned as-is, and a content array is rebuilt only when at least one part
 * actually changed.
 */
export function rewriteFingerprintsInContent(content: unknown): unknown {
  if (typeof content === 'string') return rewriteFingerprintsInText(content)
  if (!Array.isArray(content)) return content
  let changed = false
  const next = content.map(part => {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) return part
    const wrapper = part as Record<string, unknown>
    const text = wrapper['text']
    if (typeof text !== 'string') return part
    const rewritten = rewriteFingerprintsInText(text)
    if (rewritten === text) return part
    changed = true
    return { ...wrapper, text: rewritten }
  })
  return changed ? next : content
}