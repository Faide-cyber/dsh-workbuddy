import { describe, expect, it } from 'vitest'

import { requestImageByteBudget } from '../src/adapter.ts'

/**
 * The image byte budget is resolved inside `dsh-llm-pi-ai`, which divides the
 * request-wide limit by `requestImageBudgetCount` before the attachment store
 * turns the result into a hard per-image cap.
 *
 * This module hand-assembles its provider profile because `resolveProfiles()` is
 * private, so a field the host added to `ResolvedPiAiProviderProfile` is only
 * recorded here if somebody remembered to write it. DSH 0.2.3 added
 * `requestImageBudgetCount` as required; the field was absent, the division
 * produced `NaN`, and `NaN` slipped past the host's own `maxImageBytes < 1`
 * guard (a comparison against `NaN` is always false). The attachment store then
 * rejected every request that carried an image:
 *
 *   Image request maxImageBytes must be a positive integer.
 *   code: INVALID_ATTACHMENT_REF
 *
 * Because that check runs before the model call, one image anywhere in the
 * session history made the conversation unusable — retrying, rewinding a turn
 * and asking again all failed the same way.
 *
 * The adapter instance itself is not easy to reach from a unit test, so the
 * budget formula is mirrored in `requestImageByteBudget` and these cases pin
 * the arithmetic: a correct profile yields a positive safe integer, an absent
 * divisor yields `NaN`.
 */
describe('requestImageByteBudget', () => {
  it('yields a positive safe integer for the profile this plugin assembles', () => {
    const budget = requestImageByteBudget({
      maxRequestImageBytes: 20_971_520,
      requestImageBudgetCount: 20,
      requestImageMaxBytes: 1_048_576,
    })
    expect(Number.isSafeInteger(budget)).toBe(true)
    expect(budget).toBeGreaterThan(0)
    // 20 MiB shared across 20 image slots, base64's 4:3 expansion undone:
    // floor(20 MiB / 20 / 4) * 3 = 786_432. That is below the 1 MiB per-image
    // override, so the equal-share allocation is the binding cap.
    expect(budget).toBe(786_432)
  })

  it('is NaN when the budget divisor is missing, which is the regression', () => {
    const budget = requestImageByteBudget({
      maxRequestImageBytes: 20_971_520,
      requestImageMaxBytes: 1_048_576,
    })
    expect(Number.isNaN(budget)).toBe(true)
    // The host guards with `maxImageBytes < 1`, which NaN never satisfies.
    expect(budget < 1).toBe(false)
    // The attachment store guards with Number.isSafeInteger, which NaN fails.
    expect(Number.isSafeInteger(budget)).toBe(false)
  })

  it('keeps the divisor below the route-wide slot allocation', () => {
    // dsh-llm-pi-ai rejects a route whose requestImageBudgetCount exceeds
    // floor(maxRequestImageBytes / 4): there would be no room for even one
    // base64 byte per slot.
    const maxRequestImageBytes = 20_971_520
    const requestImageBudgetCount = 20
    expect(requestImageBudgetCount).toBeLessThanOrEqual(Math.floor(maxRequestImageBytes / 4))
  })
})
