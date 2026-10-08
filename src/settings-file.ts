/**
 * Card-edited configuration, kept in the plugin's own file under `$DSH_HOME`.
 *
 * The DSH settings service is the natural home for this, and the plugin still
 * registers with it (that is what puts the provider on the Models settings
 * page), but it is not a reliable *write* path here: registration never
 * completed in this profile, so every card edit was lost on restart. A switch
 * that does not stick is worse than one that says it is temporary, so the edits
 * live in a file this plugin owns end to end.
 *
 * The file sits beside the plugin's credential copy, carries no token or
 * prompt, and is read back through {@link sanitizeSavedConfig}: a file on disk
 * is untrusted input, and a hand-edited one must not be able to inject a value
 * the schema would have rejected.
 *
 * @module dsh-workbuddy/settings-file
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Config } from './index.ts'
import type { WorkBuddyModelScope } from './catalog.ts'

/** Basename of the plugin-owned settings file inside the Harness home. */
export const WORKBUDDY_SETTINGS_FILENAME = '.workbuddy-ai-settings.json'

/** Plugin-owned settings path inside the Harness home. */
export function workBuddySettingsPath(): string {
  return join(resolveDshHome(), WORKBUDDY_SETTINGS_FILENAME)
}

/**
 * Read the stored edits, or `{}` when there is no file, it is unreadable, or it
 * is not a JSON object. Never throws: a missing or damaged file means "nothing
 * was saved", which is exactly the pre-file behaviour.
 */
export function readWorkBuddySettings(path: string = workBuddySettingsPath()): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {}
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Write the stored edits atomically. Unlike the probe store this **throws** on
 * failure: the control route turns that into a 500 the card renders, and a
 * silent no-op is precisely the bug this file exists to fix.
 */
export function writeWorkBuddySettings(
  values: Record<string, unknown>,
  path: string = workBuddySettingsPath(),
): void {
  const directory = dirname(path)
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  const temporary = resolve(`${path}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

/** Keys the card may edit, and the check each value must pass to be trusted. */
const SAVED_FIELDS: { [K in keyof Config]-?: (value: unknown) => Config[K] | undefined } = {
  authFile: value => typeof value === 'string' ? value : undefined,
  cnAuthFile: value => typeof value === 'string' ? value : undefined,
  refreshActiveMinutes: value => typeof value === 'number' && value >= 1 ? value : undefined,
  refreshInactiveMinutes: value => typeof value === 'number' && value >= 1 ? value : undefined,
  autoCheckin: value => typeof value === 'boolean' ? value : undefined,
  probeConsent: value => typeof value === 'boolean' ? value : undefined,
  modelScope: value => scope(value),
  cnModelScope: value => scope(value),
  disabledModels: value => strings(value),
  cnDisabledModels: value => strings(value),
  allowedHosts: value => strings(value),
}

function scope(value: unknown): WorkBuddyModelScope | undefined {
  return value === 'free' || value === 'all' ? value : undefined
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every(entry => typeof entry === 'string') ? [...value] as string[] : undefined
}

/**
 * Keep only the known fields whose stored value still passes the schema's
 * check. An unknown key or a wrong-typed value is dropped rather than trusted:
 * the alternative is a hand-edited file deciding what the plugin runs with.
 */
export function sanitizeSavedConfig(raw: Record<string, unknown>): Partial<Config> {
  const saved: Record<string, unknown> = {}
  for (const [key, check] of Object.entries(SAVED_FIELDS)) {
    if (!(key in raw)) continue
    const value = check(raw[key])
    if (value !== undefined) saved[key] = value
  }
  return saved as Partial<Config>
}
