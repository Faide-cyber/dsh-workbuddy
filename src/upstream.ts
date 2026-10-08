/**
 * WorkBuddy (international) upstream client: chat streaming, token refresh,
 * model catalog, and credit balance.
 *
 * Two deployment-specific facts drive this module, and both are the reason the
 * plugin exists rather than reusing a domestic-configured route:
 *
 * 1. **The catalog path differs by region.** The overseas deployment serves the
 *    personal model catalog at `/v2/enterprises/personal/models`; the domestic
 *    one serves it at `/console/enterprises/personal/models`. Calling the wrong
 *    one against `www.workbuddy.ai` is not a 404 — the edge answers HTTP 500.
 *    {@link WorkBuddyUpstreamClient.fetchModels} therefore picks the path from
 *    the credential's own `domain`, so a `.ai` sign-in can never be sent to the
 *    domestic path.
 * 2. **The catalog is not the authority on price.** It lists `hy4-preview` at
 *    `x0.00` while the app's product configuration prices it `x0.29`, and it
 *    omits two genuinely free models entirely. Free/paid is therefore decided
 *    from the product configuration (see `product-config.ts`), never from this
 *    endpoint's `credits` field alone.
 *
 * The wire behavior is ported from Sliverkiss/workbuddy2api (MIT), whose Go
 * implementation is battle-tested against the real endpoint.
 *
 * @module dsh-workbuddy/upstream
 */

import type { WorkBuddyCredential } from './auth.ts'
import type { ProbeAttempt } from './probe.ts'
import { PROBE_MAX_TOKENS, PROBE_PROMPT } from './probe.ts'

/** WorkBuddy region selected by the credential's login domain. */
export type WorkBuddyRegion = 'cn' | 'global'

/** Upstream failure classes the shim maps onto distinct HTTP answers. */
export type UpstreamErrorKind =
  | 'hard_credit'
  | 'soft_rate'
  | 'session_dead'
  | 'not_found'
  | 'server'
  | 'client'

/** One CLI-usable model as the upstream catalog describes it. */
export interface WorkBuddyUpstreamModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  /**
   * Upstream-declared image input capability. Missing or false upstream data
   * resolves to false, so an unknown model stays text-only: over-claiming
   * admits an image the provider then rejects after the message is durable.
   */
  supportsImages: boolean
  /**
   * Reasoning metadata the upstream catalog declares per model. The wire effort
   * values (`low`, `medium`, `high`, `xhigh`, `max`) map directly onto pi-ai's
   * thinking levels, and the supported set decides which levels the DSH model
   * selector offers.
   */
  reasoning?: WorkBuddyModelReasoning
  /**
   * Billing convenience metadata: the credits multiplier the upstream reports
   * (e.g. `"x0.00"` for free) and promotional badges like
   * `badge:限时免费:#FF0000`.
   *
   * The multiplier reaches the browser through the host LLM seam, which has no
   * locale service, so {@link normalizeCredits} trims it to a language-neutral
   * display form (`x0.79`) that reads the same in every UI language.
   */
  billing?: WorkBuddyModelBilling
}

/** Reasoning metadata the upstream catalog declares for one model. */
export interface WorkBuddyModelReasoning {
  /** Whether the model does any reasoning at all (upstream `supportsReasoning`). */
  supports: boolean
  /** Whether the model can only think (upstream `onlyReasoning`). */
  onlyReasoning: boolean
  /** Selectable effort values; absent means the model has no explicit set. */
  supportedEfforts?: readonly WorkBuddyEffort[]
  /** Default effort the upstream uses when none is chosen. */
  defaultEffort?: WorkBuddyEffort
  /** Whether thinking can be switched off; false means it is always on. */
  canDisableThinking: boolean
}

/** The concrete effort spellings WorkBuddy exposes on the wire. */
export type WorkBuddyEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Billing convenience metadata reported for one model. */
export interface WorkBuddyModelBilling {
  /** Credits multiplier, e.g. `"x0.00"` (free) or `"x0.79"`. */
  credits?: string
  /** Promotional tags, e.g. `"限时免费"`, `"夜间折扣"`. */
  badges?: readonly string[]
  /** Whether the model is currently free (`x0.00` credits). */
  free: boolean
}

/** One billing package and its remaining credit. */
export interface WorkBuddyCreditAccount {
  packageName: string
  remain: number
  size: number
  /**
   * Upstream `CapacityType`. `4` is the monthly plan quota (`套餐基础积分`),
   * `1` a granted bonus pack (`平台奖励积分`); the app groups credits by this
   * and never shows the upstream package name. Verified identical on both
   * regions: the global account reports `Free Plan Subscription` type 4 and
   * `Bonus Pack` type 1.
   */
  capacityType: number
  /**
   * When this package stops being usable, as epoch ms. The upstream leaves
   * `ExpiredTime` empty on every package it reports and puts the real end on
   * `CycleEndTime` (`YYYY-MM-DD HH:mm:ss`), so that is the field read.
   */
  expiresAt?: number
}

/** Aggregated credit answer for one credential. */
export interface WorkBuddyCredits {
  total: number
  accounts: readonly WorkBuddyCreditAccount[]
}

/** Token refresh answer; fields the upstream omits stay absent. */
export interface WorkBuddyRefreshOutcome {
  accessToken: string
  refreshToken?: string
  expiresInSec?: number
  domain?: string
}

/** Chat answer: either a live SSE response or a classified failure. */
export type WorkBuddyChatResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; kind: UpstreamErrorKind; message: string }

const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'

/**
 * Personal model-catalog paths per region, preferred first.
 *
 * The domestic `/v3/config` is the catalog the app itself reads: its `cli`
 * roster carries the free `hy4-preview-f` slot at `x0.00`. The legacy
 * personal-models path is the CLI-channel roster, whose second slot is the
 * *paid* `hy4-preview` (`x0.29`) under the same display name "Hy4 preview" —
 * real, but the wrong price list to build a picker from. Keep it as fallback.
 */
const CATALOG_PATH: Readonly<Record<WorkBuddyRegion, readonly string[]>> = {
  global: ['/v2/enterprises/personal/models'],
  cn: ['/v3/config', '/console/enterprises/personal/models'],
}

const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS: readonly string[] = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/** The concrete effort spellings WorkBuddy exposes on the wire. */
const EFFORT_VALUES: readonly WorkBuddyEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Promotional badge keys the upstream tags carry, minus their color suffix. */
const BADGE_PREFIX = 'badge:'

/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS: readonly string[] = ['Offline user session not found', '12153']

/** Parse the upstream `reasoning` object into {@link WorkBuddyModelReasoning}. */
function resolveUpstreamReasoning(wrapped: Record<string, unknown>): { reasoning: WorkBuddyModelReasoning } {
  const supports = wrapped['supportsReasoning'] === true
  const onlyReasoning = wrapped['onlyReasoning'] === true
  const rawReasoning = wrapped['reasoning']
  let supportedEfforts: WorkBuddyEffort[] | undefined
  let defaultEffort: WorkBuddyEffort | undefined
  let canDisableThinking = true
  if (typeof rawReasoning === 'object' && rawReasoning !== null && !Array.isArray(rawReasoning)) {
    const reasoning = rawReasoning as Record<string, unknown>
    const rawEfforts = reasoning['supportedEfforts']
    if (Array.isArray(rawEfforts)) {
      const efforts = rawEfforts.filter((value): value is WorkBuddyEffort =>
        typeof value === 'string' && (EFFORT_VALUES as readonly string[]).includes(value))
      if (efforts.length > 0) supportedEfforts = efforts
    }
    if (typeof reasoning['defaultEffort'] === 'string'
      && (EFFORT_VALUES as readonly string[]).includes(reasoning['defaultEffort'] as string)) {
      defaultEffort = reasoning['defaultEffort'] as WorkBuddyEffort
    } else if (typeof reasoning['effort'] === 'string'
      && (EFFORT_VALUES as readonly string[]).includes(reasoning['effort'] as string)) {
      defaultEffort = reasoning['effort'] as WorkBuddyEffort
    }
    // Only an explicit `canDisableThinking: true` offers "thinking off"; older
    // rows omit the field and several of them reject `off` on the wire, so the
    // conservative default is "cannot be disabled".
    canDisableThinking = reasoning['canDisableThinking'] === true
  }
  return {
    reasoning: {
      supports,
      onlyReasoning,
      ...supportedEfforts === undefined ? {} : { supportedEfforts },
      ...defaultEffort === undefined ? {} : { defaultEffort },
      canDisableThinking,
    },
  }
}

/**
 * Reduce an upstream credits string to its language-neutral display form.
 *
 * The host LLM seam carries this text to the browser, and the host has no
 * locale service — whatever string is produced here is shown verbatim in every
 * UI language. The upstream is inconsistent in a way that matters: some rows
 * report a bare multiplier (`x0.79`) and others append a unit word
 * (`x0.79 credits`), and the unit word would pin the display to English.
 * Dropping a trailing `credits` (case-insensitive, singular or plural) yields
 * the one spelling that reads identically in every language.
 *
 * @param credits - raw upstream credits string, e.g. `"x0.79 credits"`.
 * @returns the bare multiplier, or undefined when nothing displayable remains.
 */
/**
 * Read an upstream timestamp string as epoch ms.
 *
 * `CycleEndTime` arrives as `YYYY-MM-DD HH:mm:ss` with no zone and is Beijing
 * wall time on the serving side, so parsing it with `new Date(string)` would
 * silently reinterpret it in the host's own zone. The parts are read as UTC and
 * shifted by a fixed +08:00 instead, which is exact for the upstream and never
 * depends on where the host happens to run.
 *
 * @param value - raw upstream value, e.g. `"2026-10-31 23:59:59"`.
 * @returns epoch ms, or undefined when the value is absent or unparseable.
 */
export function parseUpstreamExpiry(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const matched = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/u.exec(value.trim())
  if (matched === null) return undefined
  const [, year, month, day, hour, minute, second] = matched
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) - 8 * 3_600_000
}

export function normalizeCredits(credits: string | undefined): string | undefined {
  if (credits === undefined) return undefined
  const trimmed = credits.trim()
  if (trimmed === '') return undefined
  // A string that is only the unit word (`credits`) carries no multiplier.
  if (/^credits?$/iu.test(trimmed)) return undefined
  const bare = trimmed.replace(/\s+credits?$/iu, '').trim()
  return bare === '' ? undefined : bare
}

/**
 * Whether a credits multiplier means "free".
 *
 * Only an explicit `x0.00` (with or without the `x`, any number of decimals)
 * counts. An absent multiplier is *not* free: the upstream omits the field for
 * some rows and treating absence as free would advertise a paid model.
 */
export function isFreeCredits(credits: string | undefined): boolean {
  const bare = normalizeCredits(credits)
  if (bare === undefined) return false
  return /^x?0(?:\.0+)?$/u.test(bare)
}

/** Parse the upstream `tags` / `credits` fields into billing metadata. */
function resolveUpstreamBilling(wrapped: Record<string, unknown>): { billing: WorkBuddyModelBilling } {
  const rawCredits = wrapped['credits']
  const credits = typeof rawCredits === 'string' && rawCredits.trim() !== '' ? rawCredits.trim() : undefined
  const badges: string[] = []
  const rawTags = wrapped['tags']
  if (Array.isArray(rawTags)) {
    for (const tag of rawTags) {
      if (typeof tag !== 'string') continue
      const lowered = tag.toLowerCase()
      if (!lowered.startsWith(BADGE_PREFIX)) continue
      const label = tag.slice(BADGE_PREFIX.length).split(':')[0] ?? tag.slice(BADGE_PREFIX.length)
      if (label !== '') badges.push(label)
    }
  }
  return {
    billing: {
      ...credits === undefined ? {} : { credits },
      ...badges.length === 0 ? {} : { badges },
      free: isFreeCredits(credits),
    },
  }
}

/** Classify an upstream failure from its HTTP status and body excerpt. */
export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  if (status === 402) return 'hard_credit'
  const lower = body.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard_credit'
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return 'session_dead'
  }
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'client'
}

/**
 * Region for a login domain.
 *
 * An empty domain resolves to `global`, not `cn`: this plugin is the
 * international one, so an unlabelled credential is treated as belonging to the
 * deployment it was configured for. A credential that names the domestic domain
 * still routes domestic, because the `domain` field is the upstream's own
 * routing fact and second-guessing it would send a `.cn` token to `.ai`.
 */
export function regionOf(domain: string): WorkBuddyRegion {
  const lowered = domain.trim().toLowerCase()
  if (lowered === '' || lowered.endsWith('workbuddy.ai') || lowered.endsWith('codebuddy.ai')) return 'global'
  return 'cn'
}

function chatBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_CHAT_BASE
}

function billingBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

function originReferer(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

/** Headers every upstream request shares. */
function commonHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originReferer(credential),
    'Referer': `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA,
  }
}

/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    ...commonHeaders(credential),
    'Content-Type': 'application/json',
    // Security boundary: a chat request never carries the refresh token.
    ...credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid },
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId },
    ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
    'X-Product': 'SaaS',
  }
}

/** Unauthenticated CLI-login headers; no Bearer, no refresh token. */
function pluginAuthHeaders(region: WorkBuddyRegion = 'global'): Record<string, string> {
  const origin = region === 'global' ? GLOBAL_BASE : CN_CHAT_BASE
  return {
    'Accept': '*/*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': origin,
    'Referer': `${origin}/`,
    'User-Agent': CLIENT_UA,
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
  }
}

/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  return headers
}

/** Billing request headers. */
function billingHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy upstream.
 *
 * Three rewrites, each fixing a measured rejection:
 *
 * 1. `stream` is forced true — the upstream refuses a non-streaming chat call.
 * 2. `role: "developer"` becomes `role: "system"` — pi-ai emits the system
 *    prompt with the OpenAI `developer` role, which this upstream answers with
 *    HTTP 400 code 11128.
 * 3. `tool_choice` is flattened to the string form the upstream expects; an
 *    object form returns 400.
 *
 * It additionally guarantees the upstream's "first message is system prompt"
 * rule: a request whose first message is not a system message is answered with
 * code 11128 and never reaches a model. DSH normally supplies a system prompt,
 * but a session with an empty instruction set would otherwise fail every call,
 * so a minimal one is prepended rather than letting the request die.
 *
 * @param source - the JSON request body pi-ai produced.
 * @returns the rewritten body, or the input unchanged when it is not a JSON object.
 */
export function prepareChatBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  obj['stream'] = true
  normalizeDeveloperRole(obj)
  normalizeToolChoice(obj)
  ensureLeadingSystemMessage(obj)
  return JSON.stringify(obj)
}

/** Rewrite `role: "developer"` messages to `role: "system"` (upstream rejects developer). */
function normalizeDeveloperRole(obj: Record<string, unknown>): void {
  const messages = obj['messages']
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
    const wrapped = message as Record<string, unknown>
    if (wrapped['role'] === 'developer') wrapped['role'] = 'system'
  }
}

/**
 * Guarantee the upstream's requirement that the first message is a system
 * prompt. Only an actually-missing leading system message is repaired; a body
 * with no `messages` array at all is left alone, because the upstream's own
 * validation is the better error for a malformed request.
 */
function ensureLeadingSystemMessage(obj: Record<string, unknown>): void {
  const messages = obj['messages']
  if (!Array.isArray(messages) || messages.length === 0) return
  const first = messages[0]
  if (typeof first === 'object' && first !== null && !Array.isArray(first)
    && (first as Record<string, unknown>)['role'] === 'system') {
    return
  }
  messages.unshift({ role: 'system', content: 'You are a helpful assistant.' })
}

/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj: Record<string, unknown>): void {
  const suppress = (): void => {
    delete obj['tools']
    delete obj['functions']
  }
  const present = 'tool_choice' in obj
  if (!present) return
  const choice: unknown = obj['tool_choice']
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj['tool_choice']
      suppress()
    }
    return
  }
  if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
    const wrapped = choice as Record<string, unknown>
    const type = typeof wrapped['type'] === 'string' ? wrapped['type'].trim().toLowerCase() : ''
    if (type === 'none') {
      delete obj['tool_choice']
      suppress()
    } else if (type === 'auto' || type === 'required') {
      obj['tool_choice'] = type
    } else if (type === 'function') {
      const fn = typeof wrapped['function'] === 'object' && wrapped['function'] !== null
        ? (wrapped['function'] as Record<string, unknown>)
        : undefined
      let name = typeof fn?.['name'] === 'string' ? fn['name'] : ''
      if (name === '' && typeof wrapped['name'] === 'string') name = wrapped['name']
      name = name.trim()
      obj['tool_choice'] = name !== '' ? name : 'auto'
    } else {
      delete obj['tool_choice']
    }
    return
  }
  delete obj['tool_choice']
}

/** One JSON-envelope response from the upstream, already unwrapped. */
interface Envelope {
  code: number
  msg: string
  data: unknown
}

async function readEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`workbuddy-ai upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`workbuddy-ai upstream returned an unexpected document (http ${response.status})`)
  }
  const document = parsed as Record<string, unknown>
  return {
    code: typeof document['code'] === 'number' ? document['code'] : 0,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data: 'data' in document ? document['data'] : undefined,
  }
}

/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status: number, envelope: Envelope): Error {
  const kind = classifyUpstreamError(status, envelope.msg)
  return new Error(`workbuddy-ai upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`)
}

/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take the
 * credential explicitly so token refreshes apply on the next call.
 */
export class WorkBuddyUpstreamClient {
  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  async chatStream(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    let response: Response
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential), 'Authorization': `Bearer ${credential.accessToken}` },
        body: bodyJson,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
    }
  }

  /** POST the token-refresh endpoint; the caller merges the outcome. */
  async refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome> {
    const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
    if (accessToken === '') {
      throw new Error('workbuddy-ai token refresh returned no accessToken; sign in again in the WorkBuddy app')
    }
    const outcome: WorkBuddyRefreshOutcome = { accessToken }
    if (typeof data['refreshToken'] === 'string' && data['refreshToken'] !== '') outcome.refreshToken = data['refreshToken']
    if (typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0) outcome.expiresInSec = data['expiresIn']
    if (typeof data['domain'] === 'string' && data['domain'] !== '') outcome.domain = data['domain']
    return outcome
  }

  /** POST the official CLI login start; returns the browser `authUrl`. */
  async startPluginLogin(nonce: string, region: WorkBuddyRegion = 'global'): Promise<{ state: string; authUrl: string }> {
    const base = region === 'global' ? GLOBAL_BASE : CN_CHAT_BASE
    const response = await fetch(
      `${base}/v2/plugin/auth/state?platform=CLI&nonce=${encodeURIComponent(nonce)}`,
      {
        method: 'POST',
        headers: pluginAuthHeaders(region),
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      },
    )
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const state = typeof data['state'] === 'string' ? data['state'] : ''
    const authUrl = typeof data['authUrl'] === 'string' ? data['authUrl'] : ''
    if (state === '' || authUrl === '') {
      throw new Error('workbuddy-ai login start missing state/authUrl')
    }
    return { state, authUrl }
  }

  /**
   * GET the CLI login token. Envelope code `11217` means the browser has not
   * finished yet — returns `undefined` so the caller can poll again.
   */
  async pollPluginToken(state: string, region: WorkBuddyRegion = 'global'): Promise<Record<string, unknown> | undefined> {
    const base = region === 'global' ? GLOBAL_BASE : CN_CHAT_BASE
    const response = await fetch(
      `${base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`,
      {
        headers: pluginAuthHeaders(region),
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      },
    )
    const envelope = await readEnvelope(response)
    if (envelope.code === 11217) return undefined
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    if (typeof envelope.data !== 'object' || envelope.data === null) {
      throw new Error('workbuddy-ai login token returned no data')
    }
    return envelope.data as Record<string, unknown>
  }

  /**
   * GET the personal model catalog from the region's own path and keep the
   * `cli` agent's models only.
   *
   * The path is chosen from the credential's domain (see {@link CATALOG_PATH}):
   * the overseas host answers the domestic path with HTTP 500, so this is what
   * makes an international sign-in work at all.
   */
  async fetchModels(credential: WorkBuddyCredential): Promise<readonly WorkBuddyUpstreamModel[]> {
    const paths = CATALOG_PATH[regionOf(credential.domain)]
    let failure: Error | undefined
    for (const path of paths) {
      try {
        return await this.readCatalog(credential, path)
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
      }
    }
    throw failure ?? new Error('workbuddy-ai model catalog has no path to read')
  }

  /** GET one catalog path and keep the `cli` agent's models only. */
  private async readCatalog(
    credential: WorkBuddyCredential,
    path: string,
  ): Promise<readonly WorkBuddyUpstreamModel[]> {
    const response = await fetch(`${chatBase(credential)}${path}`, {
      headers: {
        'Authorization': `Bearer ${credential.accessToken}`,
        'Accept': 'application/json',
        'Origin': originReferer(credential),
        'Referer': `${originReferer(credential)}/`,
        'User-Agent': CLIENT_UA,
      },
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const rawModels = Array.isArray(data['models']) ? data['models'] : []
    const agents = Array.isArray(data['agents']) ? data['agents'] : []
    let cliIds: readonly string[] | undefined
    for (const agent of agents) {
      if (typeof agent === 'object' && agent !== null) {
        const wrapped = agent as Record<string, unknown>
        if (wrapped['name'] === 'cli' && Array.isArray(wrapped['models'])) {
          cliIds = wrapped['models'].filter((id): id is string => typeof id === 'string')
          break
        }
      }
    }
    if (cliIds === undefined || cliIds.length === 0) {
      throw new Error('workbuddy-ai model catalog lists no cli agent models')
    }
    const byId = new Map<string, WorkBuddyUpstreamModel>()
    for (const model of rawModels) {
      if (typeof model !== 'object' || model === null) continue
      const wrapped = model as Record<string, unknown>
      const id = typeof wrapped['id'] === 'string' ? wrapped['id'] : ''
      if (id === '' || wrapped['disabled'] === true) continue
      const input = typeof wrapped['maxInputTokens'] === 'number' ? wrapped['maxInputTokens'] : 0
      const output = typeof wrapped['maxOutputTokens'] === 'number' ? wrapped['maxOutputTokens'] : 0
      if (input <= 0 || output <= 0) continue
      byId.set(id, {
        id,
        name: typeof wrapped['name'] === 'string' && wrapped['name'] !== '' ? wrapped['name'] : id,
        contextWindow: input,
        maxTokens: output,
        supportsImages: wrapped['supportsImages'] === true && wrapped['disabledMultimodal'] !== true,
        ...resolveUpstreamReasoning(wrapped),
        ...resolveUpstreamBilling(wrapped),
      })
    }
    const models = cliIds
      .map(id => byId.get(id))
      .filter((model): model is WorkBuddyUpstreamModel => model !== undefined)
    if (models.length === 0) throw new Error('workbuddy-ai model catalog resolved to an empty list')
    return models
  }

  /** POST the billing endpoint for the aggregated remaining credit. */
  async fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    const now = new Date()
    const format = (date: Date): string => [
      date.getFullYear().toString().padStart(4, '0'),
      (date.getMonth() + 1).toString().padStart(2, '0'),
      date.getDate().toString().padStart(2, '0'),
    ].join('-') + ' ' + [
      date.getHours().toString().padStart(2, '0'),
      date.getMinutes().toString().padStart(2, '0'),
      date.getSeconds().toString().padStart(2, '0'),
    ].join(':')
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: format(now),
        PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const responseWrapper = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const data = typeof responseWrapper['Response'] === 'object' && responseWrapper['Response'] !== null
      ? responseWrapper['Response'] as Record<string, unknown>
      : {}
    const inner = typeof data['Data'] === 'object' && data['Data'] !== null
      ? data['Data'] as Record<string, unknown>
      : {}
    const rawAccounts = Array.isArray(inner['Accounts']) ? inner['Accounts'] : []
    const accounts: WorkBuddyCreditAccount[] = []
    let total = 0
    for (const raw of rawAccounts) {
      if (typeof raw !== 'object' || raw === null) continue
      const account = raw as Record<string, unknown>
      const numberField = (key: string): number => (typeof account[key] === 'number' ? account[key] as number : 0)
      const monthly = numberField('CapacityType') === 4
      const size = monthly ? numberField('CycleCapacitySize') : numberField('CapacitySize')
      const remain = Math.max(0, monthly ? numberField('CycleCapacityRemain') : numberField('CapacityRemain'))
      total += remain
      const expiresAt = parseUpstreamExpiry(account['CycleEndTime'])
      accounts.push({
        packageName: typeof account['PackageName'] === 'string' ? account['PackageName'] : '(unnamed)',
        remain,
        size,
        capacityType: numberField('CapacityType'),
        ...expiresAt === undefined ? {} : { expiresAt },
      })
    }
    return { total, accounts }
  }

  /** A catalog request is a low-cost connectivity check; it never sends a chat completion. */
  async testConnectivity(credential: WorkBuddyCredential): Promise<void> {
    await this.fetchModels(credential)
  }

  /** Read the domestic daily-check-in state. International accounts do not support this API. */
  async fetchCheckinStatus(credential: WorkBuddyCredential): Promise<{
    active: boolean
    todayCheckedIn: boolean
    streakDays?: number
    dailyCredit?: number
    todayCredit?: number
  }> {
    if (regionOf(credential.domain) !== 'cn') throw new Error('workbuddy-ai: daily check-in is only available for domestic accounts')
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/checkin-activity-status`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown> : {}
    const nested = typeof data['Data'] === 'object' && data['Data'] !== null
      ? data['Data'] as Record<string, unknown> : data
    const boolField = (...keys: string[]): boolean => keys.some(key => nested[key] === true)
    const numberField = (...keys: string[]): number | undefined => {
      for (const key of keys) {
        if (typeof nested[key] === 'number') return nested[key]
      }
      return undefined
    }
    const streakDays = numberField('streak_days', 'streakDays')
    const dailyCredit = numberField('daily_credit', 'dailyCredit')
    // `today_credit` is what today actually paid out; `daily_credit` is what the
    // streak day is worth in general. The card reports the former, so a bonus
    // day does not read as "you got 300" when the day only paid 100.
    const todayCredit = numberField('today_credit', 'todayCredit')
    return {
      active: boolField('active', 'Active'),
      todayCheckedIn: boolField('today_checked_in', 'todayCheckedIn', 'TodayCheckedIn'),
      ...streakDays === undefined ? {} : { streakDays },
      ...dailyCredit === undefined ? {} : { dailyCredit },
      ...todayCredit === undefined ? {} : { todayCredit },
    }
  }

  /** Claim the domestic daily check-in reward after status says it is needed. */
  async claimDailyCheckin(credential: WorkBuddyCredential): Promise<void> {
    if (regionOf(credential.domain) !== 'cn') throw new Error('workbuddy-ai: daily check-in is only available for domestic accounts')
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/daily-checkin`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  }

  /**
   * One probe request: a real streaming chat call carrying the effort under
   * test.
   *
   * Shares {@link chatHeaders} with the normal chat path on purpose — a probe
   * must describe what a real message would experience, not a parallel code
   * path. The caller aborts as soon as a parseable event arrives; the body is
   * never assembled into an answer. `reasoning_effort` is omitted entirely
   * (rather than sent empty) when `effort` is undefined, so the baseline case is
   * a genuinely bare request.
   */
  async probeEffort(
    credential: WorkBuddyCredential,
    model: string,
    effort: string | undefined,
    signal: AbortSignal,
  ): Promise<ProbeAttempt> {
    const payload: Record<string, unknown> = {
      model,
      stream: true,
      messages: [
        { role: 'system', content: PROBE_PROMPT },
        { role: 'user', content: PROBE_PROMPT },
      ],
      max_tokens: PROBE_MAX_TOKENS,
    }
    if (effort !== undefined) payload['reasoning_effort'] = effort

    let response: Response
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential), 'Authorization': `Bearer ${credential.accessToken}` },
        body: JSON.stringify(payload),
        signal,
      })
    } catch (error: unknown) {
      return { status: 0, streamed: false, detail: `transport error: ${String(error)}` }
    }

    if (!response.ok) {
      const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
      return { status: response.status, streamed: false, ...errorCodeOf(text) }
    }

    // Read until the first parseable event, then hang up: the probe wants the
    // acceptance signal, not a completion.
    const streamed = await readFirstEvent(response)
    return { status: response.status, streamed }
  }
}

/**
 * Growth-plan ("小猫成长计划" / 派猫猫旅行) headers.
 *
 * These live under `/activity/growth/...`, **not** `/v2/...` — prefixing them
 * with `/v2/` makes the gateway answer 401 `Authorization Required`, because
 * that path is registered against a different auth plugin. This API also does
 * not read `X-User-Id`/`X-Domain`; it identifies the account from the Bearer
 * alone. It does check `Referer` against the growth center, so the header is
 * load-bearing rather than cosmetic.
 */
function growthHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const base = originReferer(credential)
  return {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Codebuddy-Request': '1',
    'X-Client-Platform': 'web',
    'Origin': base,
    'Referer': `${base}/profile/growth-center`,
  }
}

/** Where the buddy is, and what is still claimable. */
export interface WorkBuddyGrowthStatus {
  /** `idle` | `traveling` | `arrived`; anything else is an upstream surprise. */
  state: string
  recordId?: number
  /** Today's travel is used up (claimed or dispatched and already handled). */
  dailyLimitReached: boolean
  /** Credit the pending trip pays on arrival; 0 when idle. */
  rewardCredit?: number
  arriveAt?: number
  locationName?: string
}

const GROWTH_PREFIX = '/activity/growth/buddy/travel'

async function growthRequest(
  credential: WorkBuddyCredential,
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${originReferer(credential)}${GROWTH_PREFIX}${path}`, {
    method,
    headers: growthHeaders(credential),
    ...body === undefined ? {} : { body: JSON.stringify(body) },
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })
  const envelope = await readEnvelope(response)
  if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  return typeof envelope.data === 'object' && envelope.data !== null && !Array.isArray(envelope.data)
    ? envelope.data as Record<string, unknown>
    : {}
}

/**
 * Read the growth-plan state.
 *
 * Deliberately read-only: a `GET` here is what the card polls, and it must
 * never be the call that dispatches a trip.
 */
export async function fetchGrowthStatus(credential: WorkBuddyCredential): Promise<WorkBuddyGrowthStatus> {
  const data = await growthRequest(credential, '/status', 'GET')
  const number = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = data[key]
      if (typeof value === 'number') return value
    }
    return undefined
  }
  const location = typeof data['location'] === 'object' && data['location'] !== null
    ? data['location'] as Record<string, unknown> : undefined
  const recordId = number('record_id', 'recordId')
  const rewardCredit = number('reward_credit', 'rewardCredit')
  const arriveAt = number('arrive_at', 'arriveAt')
  const state = typeof data['state'] === 'string' ? data['state'] : ''
  return {
    state,
    dailyLimitReached: data['daily_limit_reached'] === true,
    ...recordId === undefined || recordId === 0 ? {} : { recordId },
    ...rewardCredit === undefined || rewardCredit === 0 ? {} : { rewardCredit },
    // Upstream sends epoch seconds, not milliseconds.
    ...arriveAt === undefined || arriveAt === 0 ? {} : { arriveAt: arriveAt * 1000 },
    ...typeof location?.['name'] === 'string' ? { locationName: location['name'] } : {},
  }
}

/**
 * The destination a trip can be sent to, as `/config` lists it.
 *
 * `depart` rejects an empty body with HTTP 400 `invalid request` — the upstream
 * does not pick a destination for you — so a caller with no preference still has
 * to name one. `/config` is the only place those ids are published.
 */
export async function fetchGrowthLocations(credential: WorkBuddyCredential): Promise<readonly number[]> {
  const data = await growthRequest(credential, '/config', 'GET')
  const locations = Array.isArray(data['locations']) ? data['locations'] : []
  const ids: number[] = []
  for (const location of locations) {
    if (typeof location !== 'object' || location === null) continue
    const id = (location as Record<string, unknown>)['id']
    if (typeof id === 'number' && id !== 0) ids.push(id)
  }
  return ids
}

/**
 * What today's trip paid, read from the trip log.
 *
 * `/status` cannot answer this: once the buddy is idle it reports
 * `reward_credit: 0` whether or not a payout happened, so the card could only
 * ever say "今日旅行已完成" and hide the credits. `/records` is the log of
 * finished trips and keeps the real amount per day.
 *
 * Returns `undefined` when there is no finished trip today, so the caller can
 * tell "not yet" apart from "paid zero".
 */
export async function fetchGrowthRewardToday(credential: WorkBuddyCredential, day: string): Promise<number | undefined> {
  const data = await growthRequest(credential, '/records', 'GET')
  const records = Array.isArray(data['records']) ? data['records'] : []
  for (const entry of records) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (record['travel_date'] !== day) continue
    // A record exists from the moment of departure; the payout lands at claim.
    if (typeof record['claimed_at'] !== 'number' || record['claimed_at'] === 0) continue
    const reward = record['reward_credit']
    if (typeof reward === 'number') return reward
  }
  return undefined
}

/**
 * Send the buddy on a trip, then claim whatever is already claimable.
 *
 * One call, because the two halves belong together: a card that dispatches at
 * dusk and claims at dawn is a card the user has to come back for. `claim` is
 * idempotent upstream (it reports "nothing to claim" rather than erroring), so
 * calling it first is safe and is what lets a trip that arrived while DSH was
 * closed get its credit on the next poll.
 *
 * `locationId` of 0 means "no preference": the first destination from `/config`
 * is used. It cannot mean "send no location" — the upstream answers that with
 * HTTP 400, which is what made this a silent no-op on the card.
 */
export async function runGrowthTrip(credential: WorkBuddyCredential, locationId = 0): Promise<{
  dispatched: boolean
  claimed?: number
  reason?: string
}> {
  const before = await fetchGrowthStatus(credential)
  if (before.state === 'arrived') {
    return { dispatched: false, ...await claimGrowth(credential, before.recordId) }
  }
  if (before.dailyLimitReached) return { dispatched: false, reason: 'daily-limit' }
  if (before.state === 'traveling') return { dispatched: false, reason: 'traveling' }
  // An unknown state is not `idle`. Departing from one could dispatch a second
  // trip on top of a live one, so the caller retries on the next poll instead.
  if (before.state !== 'idle') return { dispatched: false, reason: 'unknown-state' }

  let target = locationId
  if (target === 0) {
    const [first] = await fetchGrowthLocations(credential)
    if (first === undefined) return { dispatched: false, reason: 'no-destination' }
    target = first
  }

  try {
    await growthRequest(credential, '/depart', 'POST', { location_id: target })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    // Already traveling / already dispatched is success, not failure: another
    // actor (the app, the web page) got there first and the goal is met.
    if (/already[\s_-]?traveling/i.test(message) || /already[\s_-]?dispatched/i.test(message)) {
      return { dispatched: false, reason: 'traveling' }
    }
    if (/daily[\s_-]?limit/i.test(message)) return { dispatched: false, reason: 'daily-limit' }
    throw error
  }
  return { dispatched: true }
}

/** Collect a finished trip's credit. A missing reward reports 0, not an error. */
async function claimGrowth(
  credential: WorkBuddyCredential,
  recordId?: number,
): Promise<{ claimed?: number; reason?: string }> {
  try {
    const data = await growthRequest(
      credential,
      '/claim',
      'POST',
      recordId === undefined ? {} : { record_id: recordId },
    )
    const reward = data['reward_credit']
    return typeof reward === 'number' && reward > 0 ? { claimed: reward } : { reason: 'nothing-to-claim' }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    if (/no unclaimed|not arrived|already[\s_-]?claim/i.test(message)) return { reason: 'nothing-to-claim' }
    throw error
  }
}

/**
 * Growth-center tasks, activity reports and task claims.
 *
 * These live under `/v2/activity/growth/tasks`, not under the travel prefix, and
 * they are **soft** calls: a claim for a task that is not finished answers HTTP
 * 400 with `错误的请求`, and an already-claimed task answers a non-zero business
 * code. Both are ordinary states of a task that has already moved on, so they
 * are returned as results rather than thrown — turning them into exceptions is
 * how a whole run dies on the last, already-handled task.
 *
 * `/v2/report` is what actually lights the counters: the upstream derives task
 * progress from the events the official client reports, not from watching the
 * user. See `growth-tasks.ts` for the event shapes.
 */

/** The tasks prefix for the growth center. */
const GROWTH_TASKS_PREFIX = '/v2/activity/growth/tasks'

/** One growth-center task as the card and the orchestrator need it. */
export interface WorkBuddyGrowthTask {
  code: string
  title: string
  /** `not_accepted` | `accepted` | `completed` | `claimed`; upstream-made values pass through. */
  status: string
  current: number
  target: number
  /** 0 for tasks the upstream tracks but does not pay for. */
  rewardCredit: number
}

/** A soft growth call: transport failures still throw, business outcomes do not. */
interface GrowthSoftResult {
  ok: boolean
  code: number
  msg: string
  data: Record<string, unknown>
}

async function growthSoftRequest(
  credential: WorkBuddyCredential,
  url: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<GrowthSoftResult> {
  const response = await fetch(url, {
    method,
    headers: growthHeaders(credential),
    ...body === undefined ? {} : { body: JSON.stringify(body) },
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })
  const envelope = await readEnvelope(response)
  const data = typeof envelope.data === 'object' && envelope.data !== null && !Array.isArray(envelope.data)
    ? envelope.data as Record<string, unknown>
    : {}
  return { ok: response.ok && envelope.code === 0, code: envelope.code, msg: envelope.msg, data }
}

const growthUrl = (credential: WorkBuddyCredential, path: string): string =>
  `${originReferer(credential)}${path}`

/**
 * Every task the growth center currently lists.
 *
 * An empty list is returned as-is rather than thrown: the caller has to treat
 * "no tasks" as a failed run (it means the read did not work or the account has
 * nothing enrolled), and it can only do that if it sees the emptiness.
 */
export async function fetchGrowthTasks(credential: WorkBuddyCredential): Promise<WorkBuddyGrowthTask[]> {
  const result = await growthSoftRequest(
    credential,
    growthUrl(credential, `${GROWTH_TASKS_PREFIX}`),
    'GET',
  )
  if (!result.ok) {
    throw new Error(`workbuddy-ai upstream ${classifyUpstreamError(200, result.msg)}: ${result.msg.slice(0, 160)}`)
  }
  const raw = Array.isArray(result.data['tasks']) ? result.data['tasks'] : []
  const tasks: WorkBuddyGrowthTask[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const task = entry as Record<string, unknown>
    const code = task['task_code']
    if (typeof code !== 'string' || code === '') continue
    const progress = typeof task['progress'] === 'object' && task['progress'] !== null
      ? task['progress'] as Record<string, unknown> : {}
    const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    tasks.push({
      code,
      title: typeof task['title'] === 'string' ? task['title'] : code,
      status: typeof task['accept_status'] === 'string' ? task['accept_status'] : '',
      current: num(progress['current']),
      target: num(progress['target']),
      rewardCredit: num(task['reward_credit']),
    })
  }
  return tasks
}

/**
 * Accept tasks that are still `not_accepted`.
 *
 * An empty list is not sent: the upstream answers an empty `task_codes` with a
 * different (and useless) shape, and there is nothing to accept anyway.
 */
export async function acceptGrowthTasks(credential: WorkBuddyCredential, codes: readonly string[]): Promise<void> {
  if (codes.length === 0) return
  const result = await growthSoftRequest(
    credential,
    growthUrl(credential, `${GROWTH_TASKS_PREFIX}/accept`),
    'POST',
    { task_codes: [...codes] },
  )
  if (!result.ok) {
    throw new Error(`workbuddy-ai upstream ${classifyUpstreamError(200, result.msg)}: ${result.msg.slice(0, 160)}`)
  }
}

/**
 * Post activity events, which is what moves task progress.
 *
 * The body must be an **array** even for a single event; an object is accepted
 * by the transport and then counted nowhere.
 */
export async function reportGrowthEvents(
  credential: WorkBuddyCredential,
  events: readonly Record<string, unknown>[],
): Promise<void> {
  if (events.length === 0) return
  const result = await growthSoftRequest(
    credential,
    growthUrl(credential, '/v2/report'),
    'POST',
    [...events],
  )
  if (!result.ok) {
    throw new Error(`workbuddy-ai upstream ${classifyUpstreamError(200, result.msg)}: ${result.msg.slice(0, 160)}`)
  }
}

/**
 * Claim a finished task's credit.
 *
 * `ok: false` covers "not finished yet" (HTTP 400) and "already claimed" — both
 * mean the credit is not coming this round, which the caller records as pending
 * rather than failing the whole run.
 */
export async function claimGrowthTask(
  credential: WorkBuddyCredential,
  code: string,
): Promise<{ ok: boolean; credit?: number; reason?: string }> {
  const result = await growthSoftRequest(
    credential,
    growthUrl(credential, `/activity/growth/tasks/${encodeURIComponent(code)}/claim`),
    'POST',
    {},
  )
  if (!result.ok) return { ok: false, reason: result.msg === '' ? `http ${result.code}` : result.msg }
  const credit = result.data['credit']
  return typeof credit === 'number' && credit > 0 ? { ok: true, credit } : { ok: true }
}

/**
 * Consecutive growth-plan sign-in days.
 *
 * Worth reading back after a report run: the upstream accepts a report it then
 * counts nowhere (a missing or wrong `userId` does exactly that, with HTTP 200),
 * and `days` staying at 0 is the only outward sign.
 */
export async function fetchGrowthStreakDays(credential: WorkBuddyCredential): Promise<number | undefined> {
  const result = await growthSoftRequest(
    credential,
    growthUrl(credential, '/v2/activity/growth/streak'),
    'GET',
  )
  if (!result.ok) return undefined
  const streak = result.data['streak']
  if (typeof streak !== 'object' || streak === null) return undefined
  const days = (streak as Record<string, unknown>)['days']
  return typeof days === 'number' ? days : undefined
}

/** Pull `extError.code` out of an upstream error body, if it is shaped that way. */
function errorCodeOf(text: string): { errorCode?: string; detail?: string } {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const wrapped = parsed as Record<string, unknown>
      const extError = wrapped['extError']
      if (typeof extError === 'object' && extError !== null && !Array.isArray(extError)) {
        const code = (extError as Record<string, unknown>)['code']
        if (typeof code === 'string') return { errorCode: code, detail: code }
      }
    }
  } catch {
    // Not JSON: fall through to a plain detail line.
  }
  return { detail: text.slice(0, 200) }
}

/**
 * Consume just enough of a streaming response to know it really streams.
 *
 * Returns true on the first chunk containing a data line. Cancels the body
 * afterwards; a stream that ends or errors before that counts as not streamed,
 * because an empty 200 is not evidence the effort was accepted.
 */
async function readFirstEvent(response: Response): Promise<boolean> {
  const body = response.body
  if (body === null) return false
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return false
      const text = decoder.decode(value, { stream: true })
      if (text.includes('data:')) return true
    }
  } catch {
    return false
  } finally {
    await reader.cancel().catch(() => {})
  }
}
