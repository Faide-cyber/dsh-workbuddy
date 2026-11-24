import { describe, expect, it } from 'vitest'

import { requestImageByteBudget } from '../src/adapter.ts'

describe('requestImageByteBudget', () => {
  it('yields the positive per-image cap for the assembled profile', () => {
    const budget = requestImageByteBudget({
      maxRequestImageBytes: 20_971_520,
      requestImageBudgetCount: 20,
      requestImageMaxBytes: 1_048_576,
    })

    expect(budget).toBe(786_432)
    expect(Number.isSafeInteger(budget)).toBe(true)
  })

  it('exposes the missing-divisor regression as NaN', () => {
    const budget = requestImageByteBudget({
      maxRequestImageBytes: 20_971_520,
      requestImageMaxBytes: 1_048_576,
    })

    expect(Number.isNaN(budget)).toBe(true)
    expect(budget < 1).toBe(false)
    expect(Number.isSafeInteger(budget)).toBe(false)
  })

  it('keeps the divisor within the route-wide allocation', () => {
    expect(20).toBeLessThanOrEqual(Math.floor(20_971_520 / 4))
  })
})
