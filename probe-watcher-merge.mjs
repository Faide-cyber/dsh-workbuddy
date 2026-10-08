// Self-check for the dsh-workbuddy settings observer fix.
//
// Reproduces the exact merge the watcher performs, with the real
// SAVED_FIELDS/sanitizeSavedConfig copied verbatim from
// dsh-workbuddy/lib/index.js:1465-1499, and the real shape of
// scope.get() captured from a boot probe (every schema field present,
// defaults included).
import assert from 'node:assert/strict'

const SAVED_FIELDS = {
  authFile: v => typeof v === 'string' ? v : undefined,
  cnAuthFile: v => typeof v === 'string' ? v : undefined,
  refreshActiveMinutes: v => typeof v === 'number' && v >= 1 ? v : undefined,
  refreshInactiveMinutes: v => typeof v === 'number' && v >= 1 ? v : undefined,
  autoCheckin: v => typeof v === 'boolean' ? v : undefined,
  probeConsent: v => typeof v === 'boolean' ? v : undefined,
  modelScope: v => (v === 'free' || v === 'all') ? v : undefined,
  cnModelScope: v => (v === 'free' || v === 'all') ? v : undefined,
  disabledModels: v => Array.isArray(v) && v.every(e => typeof e === 'string') ? [...v] : undefined,
  cnDisabledModels: v => Array.isArray(v) && v.every(e => typeof e === 'string') ? [...v] : undefined,
  productConfigFile: v => typeof v === 'string' ? v : undefined,
  allowedHosts: v => Array.isArray(v) && v.every(e => typeof e === 'string') ? [...v] : undefined,
}
function sanitizeSavedConfig(raw) {
  const saved = {}
  for (const [key, check] of Object.entries(SAVED_FIELDS)) {
    if (!(key in raw)) continue
    const value = check(raw[key])
    if (value !== undefined) saved[key] = value
  }
  return saved
}

// What the card had written to .workbuddy-ai-settings.json.
const file = {
  autoCheckin: false,
  cnModelScope: 'all',
  disabledModels: [],
  cnDisabledModels: ['hy3-x', 'space-bunny', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo',
    'minimax-m3', 'minimax-m2.7', 'kimi-k3-1', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro'],
}

// What settings.register() resolves when the legacy section carries no
// workbuddy-ai keys: schema defaults for everything the card cares about.
const scopeGet = {
  refreshActiveMinutes: 15, refreshInactiveMinutes: 60,
  autoCheckin: false, probeConsent: false,
  modelScope: 'free', cnModelScope: 'free',
  disabledModels: [], cnDisabledModels: [],
  allowedHosts: [],
}

const oldWay = () => { const s = { ...file }; Object.assign(s, sanitizeSavedConfig(scopeGet)); return s }
const newWay = () => {
  const s = { ...file }
  const fromSection = sanitizeSavedConfig(scopeGet)
  for (const [key, value] of Object.entries(fromSection)) if (!(key in s)) s[key] = value
  return s
}

const before = { ...file }
const oldResult = oldWay()
const newResult = newWay()

console.log('OLD watcher result:', JSON.stringify({ cnModelScope: oldResult.cnModelScope, cnDisabledModels: oldResult.cnDisabledModels.length }))
console.log('NEW watcher result:', JSON.stringify({ cnModelScope: newResult.cnModelScope, cnDisabledModels: newResult.cnDisabledModels.length }))

assert.equal(oldResult.cnModelScope, 'free', 'old code must show the reset the user reported')
assert.equal(oldResult.cnDisabledModels.length, 0, 'old code must drop every switch')
assert.equal(newResult.cnModelScope, 'all', 'new code must keep the card scope')
assert.deepEqual(newResult.cnDisabledModels, before.cnDisabledModels, 'new code must keep every switch')

// A key the card never wrote still comes from the section.
assert.equal(newResult.refreshActiveMinutes, 15, 'section still supplies keys the card never wrote')

console.log('OK: old path reproduces the reset, new path preserves the selection')

// --- Boot seeding -----------------------------------------------------------
//
// The real reset on this host: the running settings service (dsh 0.2.0-rc.2,
// loaded from app.asar) has no `register()`, so the inject callback throws and
// `apply()` never runs. Nothing would then apply the card's file before the
// picker first asks. The catalogs are therefore seeded at construction from
// `current()`, not from the composed config alone.

// The composed config: cordis supplies {probeConsent, modelScope}, the schema
// fills in the rest of its defaults.
const composedConfig = {
  refreshActiveMinutes: 15, refreshInactiveMinutes: 60,
  autoCheckin: false, probeConsent: false,
  modelScope: 'free', cnModelScope: 'free',
  disabledModels: [], cnDisabledModels: [],
  allowedHosts: [],
}

const seedFromComposedOnly = () => ({ scope: composedConfig.cnModelScope, disabled: composedConfig.cnDisabledModels })
const seedFromCurrent = () => {
  const current = { ...composedConfig, ...sanitizeSavedConfig(file) }
  return { scope: current.cnModelScope, disabled: current.cnDisabledModels }
}

const composedOnly = seedFromComposedOnly()
const seeded = seedFromCurrent()
console.log('BOOT composed-only:', JSON.stringify({ scope: composedOnly.scope, disabled: composedOnly.disabled.length }))
console.log('BOOT seeded-from-file:', JSON.stringify({ scope: seeded.scope, disabled: seeded.disabled.length }))

assert.equal(composedOnly.scope, 'free', 'composed config alone is the reset the user sees')
assert.equal(composedOnly.disabled.length, 0, 'composed config alone drops every switch')
assert.equal(seeded.scope, 'all', 'boot seeding must honour the card file without a settings service')
assert.deepEqual(seeded.disabled, file.cnDisabledModels, 'boot seeding must keep every switch')

console.log('OK: without a settings service, construction-time seeding is what keeps the card selection')
