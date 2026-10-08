/**
 * WorkBuddy product configuration: the authority on what a model costs, and
 * the source of metadata for the models the catalog endpoint omits.
 *
 * Why this module exists at all — two measured defects in the catalog endpoint
 * (`/v2/enterprises/personal/models`) that a naive plugin would inherit:
 *
 * 1. **It is not the price authority.** The catalog reports `hy4-preview` at
 *    `x0.00` (free) while the app's own product configuration prices it
 *    `x0.29`. Trusting the catalog would advertise a paid model as free and
 *    spend the user's credit without warning.
 * 2. **It omits genuinely free models.** `deepseek-v4.1-flash` and
 *    `hy4-preview-f` are absent from the catalog entirely, yet both are
 *    `x0.00` in the product configuration. Without this module the plugin could
 *    not offer the one model this whole exercise is about.
 *
 * Where the data comes from: the WorkBuddy desktop app caches the configuration
 * it is served at `~/.workbuddy-ai/cache/acc-product-config-v3.json` (the
 * directory name comes from the config's own `dataFolderName` field, and its
 * `applicationName` is `workbuddy-ai` — the international build). That file is
 * read-only input here; this plugin never writes to the app's directory.
 *
 * When the cache is missing (fresh install, another machine, an app update that
 * renames it) the built-in {@link FALLBACK_FREE_MODELS} table serves instead, so
 * the free list never degrades to "nothing is free" or, worse, "everything is".
 *
 * @module dsh-workbuddy/product-config
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WorkBuddyEffort, WorkBuddyModelBilling, WorkBuddyModelReasoning, WorkBuddyUpstreamModel } from './upstream.ts'

/** Directory the international WorkBuddy app keeps its state in. */
export const WORKBUDDY_DATA_FOLDER = '.workbuddy-ai'

/** Cached product-configuration basename inside that directory. */
export const WORKBUDDY_PRODUCT_CONFIG_BASENAME = 'acc-product-config-v3.json'

/** Env variable overriding the product-config file location. */
export const WORKBUDDY_PRODUCT_CONFIG_ENV = 'WORKBUDDY_PRODUCT_CONFIG'

/** Absolute path of the cached product configuration. */
export function workBuddyProductConfigPath(): string {
  const override = process.env[WORKBUDDY_PRODUCT_CONFIG_ENV]
  if (override !== undefined && override.trim() !== '') return override.trim()
  return join(homedir(), WORKBUDDY_DATA_FOLDER, 'cache', WORKBUDDY_PRODUCT_CONFIG_BASENAME)
}

/** One model row from the product configuration, narrowed to what is used. */
export interface WorkBuddyProductModel {
  id: string
  name: string
  /** Credits multiplier, e.g. `"x0.00"`. Absent when the config states none. */
  credits?: string
  contextWindow: number
  maxTokens: number
  supportsImages: boolean
  supportsReasoning: boolean
  onlyReasoning: boolean
  supportedEfforts?: readonly WorkBuddyEffort[]
  defaultEffort?: WorkBuddyEffort
  canDisableThinking: boolean
}

/** The parsed slice of the product configuration this plugin consumes. */
export interface WorkBuddyProductConfig {
  /** Where the data came from, for diagnostics and the settings card. */
  source: 'cache' | 'builtin'
  /** Path consulted for `cache`; absent for `builtin`. */
  path?: string
  /** Application the config describes, e.g. `workbuddy-ai`. */
  applicationName?: string
  /** Endpoint the config points at, e.g. `https://www.workbuddy.ai`. */
  endpoint?: string
  /** Whether the config describes the overseas build. */
  isOversea?: boolean
  /** Every model row, in configuration order. */
  models: readonly WorkBuddyProductModel[]
}

const EFFORT_VALUES: readonly WorkBuddyEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Every model the international deployment prices `x0.00`, with the metadata
 * copied verbatim from the product configuration.
 *
 * This is the fallback the plugin uses when the app's cache cannot be read, and
 * it is deliberately a *whitelist of the free* rather than a blacklist of the
 * paid: a model absent from both this table and the cache is treated as paid, so
 * the failure mode is "a free model is missing" rather than "a paid model is
 * billed silently".
 *
 * `hy4-preview` (without the `-f`) is deliberately absent even though the
 * catalog endpoint reports it as `x0.00`: the product configuration prices it
 * `x0.29`, so it is paid, and it shares its display name with `hy4-preview-f` —
 * including both would show two identically-named rows, one of them billable.
 */
export const BUILTIN_FREE_MODELS: readonly WorkBuddyUpstreamModel[] = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'Deepseek-V4.1-Flash',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImages: true,
    reasoning: {
      supports: true,
      onlyReasoning: true,
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      canDisableThinking: false,
    },
    billing: { credits: 'x0.00', free: true },
  },
  {
    id: 'hy4-preview-f',
    name: 'Hy4 preview',
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportsImages: true,
    reasoning: {
      supports: true,
      onlyReasoning: true,
      supportedEfforts: ['high'],
      defaultEffort: 'high',
      canDisableThinking: false,
    },
    billing: { credits: 'x0.00', free: true },
  },
  {
    id: 'hy3',
    name: 'Hy3',
    contextWindow: 192_000,
    maxTokens: 64_000,
    supportsImages: true,
    reasoning: {
      supports: true,
      onlyReasoning: true,
      supportedEfforts: ['low', 'high'],
      defaultEffort: 'high',
      canDisableThinking: false,
    },
    billing: { credits: 'x0.00', free: true },
  },
]

/** Ids of the models the product configuration prices free. */
export const FALLBACK_FREE_MODEL_IDS: readonly string[] =
  BUILTIN_FREE_MODELS.map(model => model.id)

/**
 * Last-known international `credits` multipliers, used when the app cache is
 * absent. Catalog `x0.00` is not trusted (`hy4-preview` is x0.29 here).
 */
export const BUILTIN_CREDITS: Readonly<Record<string, string>> = {
  'deepseek-v4.1-flash': 'x0.00',
  'hy4-preview-f': 'x0.00',
  'hy3': 'x0.00',
  'hy4-preview': 'x0.29',
  'fast-model': 'x0.34',
  'balanced-model': 'x0.59',
  'primary-model': 'x3.31',
  'deep-model': 'x3.33',
  'gpt-6-astra': 'x6.67',
  'gpt-5.6-sol': 'x3.47',
  'gpt-5.6-terra': 'x1.39',
  'gpt-5.6-luna': 'x0.14',
  'gpt-5.5': 'x3.31',
  'gpt-5.4': 'x1.65',
  'gpt-5.3-codex': 'x1.25',
  'gemini-3.5-flash': 'x0.99',
  'glm-5.3': 'x0.79',
  'glm-5.2': 'x0.79',
  'kimi-k3': 'x1.62',
  'kimi-k2.6': 'x0.52',
}

/**
 * The subset the catalog endpoint does not return, so they must be injected.
 *
 * `hy3` is absent from this list because the endpoint does list it; the other
 * two are missing from the live catalog entirely.
 */
export const FALLBACK_EXTRA_MODELS: readonly WorkBuddyUpstreamModel[] =
  BUILTIN_FREE_MODELS.filter(model => model.id !== 'hy3')

/** Effort set the international deployment accepts for a model it declares none for. */
const IMPLIED_EFFORTS: readonly WorkBuddyEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Narrow one `models[]` row; returns undefined for a row with no usable id. */
function parseProductModel(value: unknown): WorkBuddyProductModel | undefined {
  const row = asRecord(value)
  if (row === undefined) return undefined
  const id = typeof row['id'] === 'string' ? row['id'].trim() : ''
  if (id === '') return undefined
  const reasoning = asRecord(row['reasoning'])
  const rawEfforts = reasoning?.['supportedEfforts']
  let supportedEfforts: WorkBuddyEffort[] | undefined
  if (Array.isArray(rawEfforts)) {
    const efforts = rawEfforts.filter((effort): effort is WorkBuddyEffort =>
      typeof effort === 'string' && (EFFORT_VALUES as readonly string[]).includes(effort))
    if (efforts.length > 0) supportedEfforts = efforts
  }
  const rawDefault = reasoning?.['defaultEffort'] ?? reasoning?.['effort']
  const defaultEffort = typeof rawDefault === 'string' && (EFFORT_VALUES as readonly string[]).includes(rawDefault)
    ? rawDefault as WorkBuddyEffort
    : undefined
  // The product config spells the output cap `maxOutputTokens` and the input
  // window `maxInputTokens`; `maxAllowedSize` is the widest selectable window and
  // serves as a fallback when the per-request cap is absent.
  const contextWindow = positiveNumber(row['maxInputTokens']) ?? positiveNumber(row['maxAllowedSize']) ?? 0
  const maxTokens = positiveNumber(row['maxOutputTokens']) ?? 0
  return {
    id,
    name: typeof row['name'] === 'string' && row['name'] !== '' ? row['name'] : id,
    ...typeof row['credits'] === 'string' && row['credits'].trim() !== ''
      ? { credits: row['credits'].trim() }
      : {},
    contextWindow,
    maxTokens,
    supportsImages: row['supportsImages'] === true && row['disabledMultimodal'] !== true,
    supportsReasoning: row['supportsReasoning'] === true,
    onlyReasoning: row['onlyReasoning'] === true,
    ...supportedEfforts === undefined ? {} : { supportedEfforts },
    ...defaultEffort === undefined ? {} : { defaultEffort },
    canDisableThinking: reasoning?.['canDisableThinking'] === true,
  }
}

/** Parse a product-configuration document; undefined when it is not usable. */
export function parseProductConfig(text: string): WorkBuddyProductConfig | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const document = asRecord(parsed)
  if (document === undefined) return undefined
  const rawModels = document['models']
  if (!Array.isArray(rawModels)) return undefined
  const models = rawModels
    .map(parseProductModel)
    .filter((model): model is WorkBuddyProductModel => model !== undefined)
  if (models.length === 0) return undefined
  return {
    source: 'cache',
    ...typeof document['applicationName'] === 'string' ? { applicationName: document['applicationName'] } : {},
    ...typeof document['endpoint'] === 'string' ? { endpoint: document['endpoint'] } : {},
    isOversea: document['isOversea'] === true,
    models,
  }
}

/** The built-in configuration: free rows with full metadata, plus paid rates. */
function builtinConfig(): WorkBuddyProductConfig {
  const models: WorkBuddyProductModel[] = BUILTIN_FREE_MODELS.map(model => ({
    id: model.id,
    name: model.name,
    credits: BUILTIN_CREDITS[model.id] ?? 'x0.00',
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    supportsImages: model.supportsImages,
    supportsReasoning: model.reasoning?.supports === true,
    onlyReasoning: model.reasoning?.onlyReasoning === true,
    ...model.reasoning?.supportedEfforts === undefined ? {} : { supportedEfforts: model.reasoning.supportedEfforts },
    ...model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort },
    canDisableThinking: model.reasoning?.canDisableThinking === true,
  }))
  const seen = new Set(models.map(model => model.id))
  for (const [id, credits] of Object.entries(BUILTIN_CREDITS)) {
    if (seen.has(id)) continue
    models.push({
      id,
      name: id,
      credits,
      contextWindow: 0,
      maxTokens: 0,
      supportsImages: false,
      supportsReasoning: false,
      onlyReasoning: false,
      canDisableThinking: false,
    })
  }
  return { source: 'builtin', models }
}

/**
 * Load the product configuration, falling back to the built-in table.
 *
 * A missing or malformed cache is never an error: the plugin must still offer
 * its free models on a machine where the app has not run yet.
 */
export function loadProductConfig(path = workBuddyProductConfigPath()): WorkBuddyProductConfig {
  try {
    const parsed = parseProductConfig(readFileSync(path, 'utf8'))
    if (parsed === undefined) return builtinConfig()
    return { ...parsed, path }
  } catch {
    return builtinConfig()
  }
}

/** Whether a credits multiplier means free (`x0.00`). Absent is not free. */
export function creditsAreFree(credits: string | undefined): boolean {
  if (credits === undefined) return false
  return /^x?0(?:\.0+)?$/u.test(credits.trim())
}

/**
 * The free model ids a configuration declares.
 *
 * Only an explicit `x0.00` counts. When the cache is absent the built-in
 * whitelist applies, so the answer is never "every model" — a mis-read must not
 * be able to turn the free-only filter into a no-op.
 */
export function freeModelIds(config: WorkBuddyProductConfig): readonly string[] {
  const free = config.models.filter(model => creditsAreFree(model.credits)).map(model => model.id)
  // An empty answer from a cache that parsed but prices nothing as free would
  // silently hide every model; the built-in list is the safer answer.
  return free.length > 0 ? free : FALLBACK_FREE_MODEL_IDS
}

/** Reasoning metadata from a product-config row, in the catalog's own shape. */
function reasoningFromProduct(model: WorkBuddyProductModel): WorkBuddyModelReasoning {
  // The international deployment accepts the full effort vocabulary for the
  // models this plugin adds, even where the product config declares only a
  // default (measured against `deepseek-v4.1-flash`, which answers 200 to every
  // level and 400 to an unknown one). Where the config *does* declare a set,
  // that set is authoritative and is used unchanged.
  const declared = model.supportedEfforts
  const efforts = declared !== undefined && declared.length > 0 ? declared : IMPLIED_EFFORTS
  return {
    supports: model.supportsReasoning,
    onlyReasoning: model.onlyReasoning,
    supportedEfforts: efforts,
    ...model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort },
    canDisableThinking: model.canDisableThinking,
  }
}

/** Billing metadata for a model the product configuration marks free. */
function billingFromProduct(model: WorkBuddyProductModel): WorkBuddyModelBilling {
  const credits = model.credits ?? 'x0.00'
  return { credits, free: creditsAreFree(credits) }
}

/**
 * Build a catalog row from a product-configuration model.
 *
 * Used for models the catalog endpoint omits. A row with no usable capacities is
 * refused rather than guessed: an unlisted model with a fabricated context
 * window would make the harness compact at the wrong point.
 */
export function productModelToCatalogRow(model: WorkBuddyProductModel): WorkBuddyUpstreamModel | undefined {
  if (model.contextWindow <= 0 || model.maxTokens <= 0) return undefined
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    supportsImages: model.supportsImages,
    reasoning: reasoningFromProduct(model),
    billing: billingFromProduct(model),
  }
}

/** Look up one product-config row by id. */
export function productModelById(
  config: WorkBuddyProductConfig,
  id: string,
): WorkBuddyProductModel | undefined {
  return config.models.find(model => model.id === id)
}
