import { describe, expect, it } from 'vitest'
import { sanitizeSavedConfig } from '../src/settings-file.ts'

describe('sanitizeSavedConfig', () => {
  it('keeps known fields whose stored value passes the schema check', () => {
    const saved = sanitizeSavedConfig({
      autoCheckin: true,
      modelScope: 'all',
      cnModelScope: 'free',
      refreshActiveMinutes: 17,
      refreshInactiveMinutes: 61,
      disabledModels: ['a', 'b'],
      cnDisabledModels: [],
    })
    expect(saved).toEqual({
      autoCheckin: true,
      modelScope: 'all',
      cnModelScope: 'free',
      refreshActiveMinutes: 17,
      refreshInactiveMinutes: 61,
      disabledModels: ['a', 'b'],
      cnDisabledModels: [],
    })
  })

  it('drops unknown keys and wrong-typed values instead of trusting the file', () => {
    // The negative half of the contract: a hand-edited file must not be able to
    // set a value the schema would have rejected.
    const saved = sanitizeSavedConfig({
      autoCheckin: 'yes',
      modelScope: 'everything',
      refreshActiveMinutes: 0,
      disabledModels: 'not-an-array',
      disabledModelsMixed: ['ok', 7],
      evil: 'drop me',
    })
    expect(saved).toEqual({})
  })

  it('drops a partially-invalid list rather than salvaging the good half', () => {
    expect(sanitizeSavedConfig({ disabledModels: ['ok', 7] })).toEqual({})
  })

  it('accepts an empty object, which is what a missing file reads as', () => {
    expect(sanitizeSavedConfig({})).toEqual({})
  })
})
