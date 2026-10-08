import z from "@deepseek-ai/schemastery";
import { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { Context } from "@deepseek-ai/cordis";
import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
//#region src/auth.d.ts
/** Normalized WorkBuddy credential, timestamps in epoch milliseconds. */
interface WorkBuddyCredential {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  domain: string;
  uid: string;
  enterpriseId?: string;
  nickname?: string;
  /** Which storage the credential was read from; refreshes are always `dsh`. */
  source: 'desktop' | 'dsh';
}
/** Read-only sign-in summary for status and doctor output. */
interface WorkBuddyAuthStatus {
  state: 'signed-in' | 'signed-out';
  expiresAtMs?: number;
  refreshExpiresAtMs?: number;
  nickname?: string;
  domain?: string;
  source?: 'desktop' | 'dsh';
}
/** Constructor options; only {@link refresh} is required. */
interface WorkBuddyStoreOptions {
  /** Explicit desktop auth-file path, overriding env and platform defaults. */
  desktopPath?: string;
  /** Explicit plugin-owned copy path, defaulting under `$DSH_HOME`. */
  ownPath?: string;
  /** Region used by the account-aware store; the legacy store defaults global. */
  region?: WorkBuddyRegion;
  /** Performs the upstream token refresh. */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>;
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number;
}
/** Basename of the plugin-owned credential copy inside the Harness home. */
declare const WORKBUDDY_AUTH_FILENAME = ".workbuddy-ai-auth.json";
/** Region-scoped plugin copy for domestic credentials. */
declare const WORKBUDDY_CN_AUTH_FILENAME = ".workbuddy-cn-auth.json";
/** Env variable that overrides the desktop auth-file location. */
declare const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
/** Domestic desktop path override. */
declare const WORKBUDDY_CN_AUTH_FILE_ENV = "WORKBUDDY_CN_AUTH_FILE";
/** Domestic desktop auth basename. */
declare const WORKBUDDY_CN_DESKTOP_AUTH_BASENAME = "workbuddy-desktop.info";
/**
 * Basename of the WorkBuddy **international** desktop auth document.
 *
 * The domestic build writes `workbuddy-desktop.info` in the same directory;
 * only the `.ai` suffix names the overseas sign-in this plugin is built for.
 */
declare const WORKBUDDY_DESKTOP_AUTH_BASENAME = "workbuddy-desktop-ai.info";
/** Plugin-owned copy path inside the Harness home. */
declare function workBuddyOwnAuthPath(): string;
/** Plugin-owned primary path for a region; global keeps the legacy filename. */
declare function workBuddyRegionOwnAuthPath(region: WorkBuddyRegion): string;
/**
 * Platform-default candidates for the WorkBuddy **international** desktop
 * app's auth file, in probe order. Windows probes both AppData roots: current
 * builds write under `%LOCALAPPDATA%` (Local), older ones under `%APPDATA%`
 * (Roaming). WSL probes those same Windows locations through its mounted
 * Windows profile before the native Linux location.
 */
declare function defaultDesktopAuthCandidates(): string[];
/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
declare function defaultDesktopAuthPath(): string | undefined;
/**
 * Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
 * nested form `{"auth":{...},"account":{...}}` and the flat panel form.
 * Returns undefined when the document carries no access token.
 */
declare function parseWorkBuddyAuth(text: string): WorkBuddyCredential | undefined;
/**
 * Turn the official CLI `/v2/plugin/auth/token` payload into a credential.
 * Identity fields come from the access-token JWT; the desktop file is not used.
 */
declare function credentialFromPluginToken(data: Record<string, unknown>, region?: WorkBuddyRegion): WorkBuddyCredential;
/** Minimal store contract shared by legacy and multi-account stores. */
interface WorkBuddyCredentialStoreLike {
  current(): Promise<WorkBuddyCredential | undefined>;
  resolve(): Promise<WorkBuddyCredential>;
  status(): Promise<WorkBuddyAuthStatus>;
  importCredential(credential: WorkBuddyCredential): Promise<WorkBuddyCredential>;
  logout(): Promise<void>;
}
/**
 * Read-only credential store with demand-driven refresh.
 *
 * Refresh policy: refresh only when the access token is inside the margin (or
 * already expired), keep the refreshed credential in the plugin-owned copy,
 * and never write the desktop app's file. A failed refresh still returns a
 * not-yet-expired token, so an unreachable refresh endpoint does not take down
 * a working session.
 */
declare class WorkBuddyCredentialStore implements WorkBuddyCredentialStoreLike {
  private readonly refresh;
  private readonly refreshMarginMs;
  private readonly ownPath;
  private desktopPathOverride;
  private inflight;
  constructor(options: WorkBuddyStoreOptions);
  /**
   * Configuration precedence for the desktop file: the plugin's configured
   * path, then the environment variable, then the platform defaults. An
   * explicit path is used verbatim; the defaults are a probe order.
   */
  private resolveDesktopCandidates;
  private resolveDesktopPath;
  /** Repoint the desktop file; a settings change applies on the next read. */
  setDesktopPath(path: string | undefined): void;
  /** The resolved desktop auth-file path, for diagnostics. */
  desktopAuthPath(): string | undefined;
  /** The plugin-owned copy path, for diagnostics. */
  ownAuthPath(): string;
  /** Read the freshest stored credential without refreshing anything. */
  current(): Promise<WorkBuddyCredential | undefined>;
  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh.
   */
  resolve(): Promise<WorkBuddyCredential>;
  /** Read-only sign-in summary; never refreshes and never throws. */
  status(): Promise<WorkBuddyAuthStatus>;
  /** Remove the plugin-owned copy; the desktop file is untouched. */
  logout(): Promise<void>;
  /** Persist a browser-OAuth credential into the plugin-owned copy. */
  importCredential(credential: WorkBuddyCredential): Promise<WorkBuddyCredential>;
  private needsRefresh;
  private refreshNow;
  private saveOwn;
  /**
   * Read the first desktop candidate that exists. Only an absent file (ENOENT)
   * falls through to the next candidate; a file that is present but unparsable
   * is authoritative for its slot, so a stale older-version file never silently
   * wins over a broken newer one.
   */
  private readDesktop;
  private readOwn;
  /** Whether any desktop-file candidate exists as a regular file; diagnostics only. */
  desktopFilePresent(): Promise<boolean>;
}
/** Token-free account row exposed to the settings card. */
interface WorkBuddyAccountSummary {
  id: string;
  region: WorkBuddyRegion;
  nickname?: string;
  note?: string;
  domain?: string;
  source: 'desktop' | 'dsh';
  expiresAtMs: number;
  selected: boolean;
  checkinEnabled: boolean;
}
interface WorkBuddyCreditSnapshot {
  credits?: WorkBuddyCredits;
  error?: string;
  checkedAt: number;
}
/**
 * Region-aware, multi-account store. The legacy primary file remains in its
 * version-1 shape for CLI/backward compatibility; additional accounts live in a
 * token-bearing sidecar owned by this plugin only.
 */
declare class WorkBuddyAccountStore implements WorkBuddyCredentialStoreLike {
  private readonly accountRefresh;
  private readonly accountRefreshMarginMs;
  private readonly region;
  private readonly accountOwnPath;
  private readonly accountsPath;
  private desktopPathOverride;
  private selectedAccountId;
  private records;
  private inflight;
  private creditSnapshots;
  private creditInflight;
  constructor(options: WorkBuddyStoreOptions);
  accountRegion(): WorkBuddyRegion;
  private desktopBasename;
  private desktopEnv;
  private desktopCandidates;
  setDesktopPath(path: string | undefined): void;
  desktopAuthPath(): string | undefined;
  ownAuthPath(): string;
  accountsAuthPath(): string;
  private readAccounts;
  private readPrimary;
  private readDesktopCredential;
  private persist;
  private needsRefresh;
  private refreshAccount;
  accounts(): Promise<readonly WorkBuddyAccountSummary[]>;
  current(): Promise<WorkBuddyCredential | undefined>;
  credentialFor(accountId: string): Promise<WorkBuddyCredential | undefined>;
  selectedId(): string | undefined;
  resolveFor(accountId: string): Promise<WorkBuddyCredential>;
  resolve(): Promise<WorkBuddyCredential>;
  status(): Promise<WorkBuddyAuthStatus>;
  refreshCreditSnapshots(fetchCredits: (credential: WorkBuddyCredential) => Promise<WorkBuddyCredits>, activeIntervalMs: number, inactiveIntervalMs: number): Promise<ReadonlyMap<string, WorkBuddyCreditSnapshot>>;
  creditSnapshot(accountId: string): WorkBuddyCreditSnapshot | undefined;
  select(accountId: string): Promise<void>;
  importCredential(credential: WorkBuddyCredential, accountId?: string): Promise<WorkBuddyCredential>;
  setCheckinEnabled(accountId: string, enabled: boolean): Promise<void>;
  /** Store a note and return the normalized value kept, or undefined when cleared. */
  setNote(accountId: string, note: string): Promise<string | undefined>;
  removeAccount(accountId: string): Promise<void>;
  /** Existing logout semantics: remove all plugin-owned credentials, never desktop auth. */
  logout(): Promise<void>;
}
//#endregion
//#region src/probe.d.ts
/**
 * The canonical values a probe tests, in a fixed order.
 *
 * `minimal` is absent: it appears in no upstream vocabulary. `off` is absent
 * by policy — disabling thinking is a separate capability the upstream must
 * declare through `canDisableThinking`, never something probing may infer.
 */
declare const PROBE_EFFORT_CANDIDATES: readonly WorkBuddyEffort[];
/** Sentinel generator; injectable so tests get deterministic values. */
type SentinelFactory = () => string;
/** Default sentinel: unmistakably non-canonical, different on every call. */
declare function randomSentinel(): string;
/**
 * One response as the probe sees it, split into the only distinctions the
 * attribution rule needs.
 */
interface ProbeAttempt {
  /** HTTP status, or 0 for a transport failure. */
  status: number;
  /** True when a parseable SSE event arrived. */
  streamed: boolean;
  /** `extError.code` from a JSON error body, when present. */
  errorCode?: string;
  /** Free-form detail for logs; never shown as a capability claim. */
  detail?: string;
}
/** How one attempt is performed; the caller owns credentials and HTTP. */
type ProbeSender = (effort: string | undefined, signal: AbortSignal) => Promise<ProbeAttempt>;
/** The outcome of probing one model. */
type ProbeOutcome = {
  validation: 'validating';
  efforts: readonly WorkBuddyEffort[];
  requests: number;
} | {
  validation: 'non-validating';
  efforts: readonly [];
  requests: number;
} | {
  validation: 'unknown';
  efforts: readonly [];
  requests: number;
  reason: string;
};
/**
 * Probe one model.
 *
 * `options.candidates` exists so tests can shorten the sweep; production always
 * uses {@link PROBE_EFFORT_CANDIDATES}.
 */
declare function probeModel(options: {
  send: ProbeSender;
  sentinel?: SentinelFactory;
  candidates?: readonly WorkBuddyEffort[];
  timeoutMs?: number;
}): Promise<ProbeOutcome>;
//#endregion
//#region src/upstream.d.ts
/** WorkBuddy region selected by the credential's login domain. */
type WorkBuddyRegion = 'cn' | 'global';
/** Upstream failure classes the shim maps onto distinct HTTP answers. */
type UpstreamErrorKind = 'hard_credit' | 'soft_rate' | 'session_dead' | 'not_found' | 'server' | 'client';
/** One CLI-usable model as the upstream catalog describes it. */
interface WorkBuddyUpstreamModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  /**
   * Upstream-declared image input capability. Missing or false upstream data
   * resolves to false, so an unknown model stays text-only: over-claiming
   * admits an image the provider then rejects after the message is durable.
   */
  supportsImages: boolean;
  /**
   * Reasoning metadata the upstream catalog declares per model. The wire effort
   * values (`low`, `medium`, `high`, `xhigh`, `max`) map directly onto pi-ai's
   * thinking levels, and the supported set decides which levels the DSH model
   * selector offers.
   */
  reasoning?: WorkBuddyModelReasoning;
  /**
   * Billing convenience metadata: the credits multiplier the upstream reports
   * (e.g. `"x0.00"` for free) and promotional badges like
   * `badge:限时免费:#FF0000`.
   *
   * The multiplier reaches the browser through the host LLM seam, which has no
   * locale service, so {@link normalizeCredits} trims it to a language-neutral
   * display form (`x0.79`) that reads the same in every UI language.
   */
  billing?: WorkBuddyModelBilling;
}
/** Reasoning metadata the upstream catalog declares for one model. */
interface WorkBuddyModelReasoning {
  /** Whether the model does any reasoning at all (upstream `supportsReasoning`). */
  supports: boolean;
  /** Whether the model can only think (upstream `onlyReasoning`). */
  onlyReasoning: boolean;
  /** Selectable effort values; absent means the model has no explicit set. */
  supportedEfforts?: readonly WorkBuddyEffort[];
  /** Default effort the upstream uses when none is chosen. */
  defaultEffort?: WorkBuddyEffort;
  /** Whether thinking can be switched off; false means it is always on. */
  canDisableThinking: boolean;
}
/** The concrete effort spellings WorkBuddy exposes on the wire. */
type WorkBuddyEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Billing convenience metadata reported for one model. */
interface WorkBuddyModelBilling {
  /** Credits multiplier, e.g. `"x0.00"` (free) or `"x0.79"`. */
  credits?: string;
  /** Promotional tags, e.g. `"限时免费"`, `"夜间折扣"`. */
  badges?: readonly string[];
  /** Whether the model is currently free (`x0.00` credits). */
  free: boolean;
}
/** One billing package and its remaining credit. */
interface WorkBuddyCreditAccount {
  packageName: string;
  remain: number;
  size: number;
  /**
   * Upstream `CapacityType`. `4` is the monthly plan quota (`套餐基础积分`),
   * `1` a granted bonus pack (`平台奖励积分`); the app groups credits by this
   * and never shows the upstream package name. Verified identical on both
   * regions: the global account reports `Free Plan Subscription` type 4 and
   * `Bonus Pack` type 1.
   */
  capacityType: number;
  /**
   * When this package stops being usable, as epoch ms. The upstream leaves
   * `ExpiredTime` empty on every package it reports and puts the real end on
   * `CycleEndTime` (`YYYY-MM-DD HH:mm:ss`), so that is the field read.
   */
  expiresAt?: number;
}
/** Aggregated credit answer for one credential. */
interface WorkBuddyCredits {
  total: number;
  accounts: readonly WorkBuddyCreditAccount[];
}
/** Token refresh answer; fields the upstream omits stay absent. */
interface WorkBuddyRefreshOutcome {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
  domain?: string;
}
/** Chat answer: either a live SSE response or a classified failure. */
type WorkBuddyChatResult = {
  ok: true;
  response: Response;
} | {
  ok: false;
  status: number;
  kind: UpstreamErrorKind;
  message: string;
};
declare function normalizeCredits(credits: string | undefined): string | undefined;
/**
 * Whether a credits multiplier means "free".
 *
 * Only an explicit `x0.00` (with or without the `x`, any number of decimals)
 * counts. An absent multiplier is *not* free: the upstream omits the field for
 * some rows and treating absence as free would advertise a paid model.
 */
declare function isFreeCredits(credits: string | undefined): boolean;
/** Classify an upstream failure from its HTTP status and body excerpt. */
declare function classifyUpstreamError(status: number, body: string): UpstreamErrorKind;
/**
 * Region for a login domain.
 *
 * An empty domain resolves to `global`, not `cn`: this plugin is the
 * international one, so an unlabelled credential is treated as belonging to the
 * deployment it was configured for. A credential that names the domestic domain
 * still routes domestic, because the `domain` field is the upstream's own
 * routing fact and second-guessing it would send a `.cn` token to `.ai`.
 */
declare function regionOf(domain: string): WorkBuddyRegion;
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
declare function prepareChatBody(source: string): string;
/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take the
 * credential explicitly so token refreshes apply on the next call.
 */
declare class WorkBuddyUpstreamClient {
  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  chatStream(credential: WorkBuddyCredential, bodyJson: string, signal?: AbortSignal): Promise<WorkBuddyChatResult>;
  /** POST the token-refresh endpoint; the caller merges the outcome. */
  refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome>;
  /** POST the official CLI login start; returns the browser `authUrl`. */
  startPluginLogin(nonce: string, region?: WorkBuddyRegion): Promise<{
    state: string;
    authUrl: string;
  }>;
  /**
   * GET the CLI login token. Envelope code `11217` means the browser has not
   * finished yet — returns `undefined` so the caller can poll again.
   */
  pollPluginToken(state: string, region?: WorkBuddyRegion): Promise<Record<string, unknown> | undefined>;
  /**
   * GET the personal model catalog from the region's own path and keep the
   * `cli` agent's models only.
   *
   * The path is chosen from the credential's domain (see {@link CATALOG_PATH}):
   * the overseas host answers the domestic path with HTTP 500, so this is what
   * makes an international sign-in work at all.
   */
  fetchModels(credential: WorkBuddyCredential): Promise<readonly WorkBuddyUpstreamModel[]>;
  /** GET one catalog path and keep the `cli` agent's models only. */
  private readCatalog;
  /** POST the billing endpoint for the aggregated remaining credit. */
  fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits>;
  /** A catalog request is a low-cost connectivity check; it never sends a chat completion. */
  testConnectivity(credential: WorkBuddyCredential): Promise<void>;
  /** Read the domestic daily-check-in state. International accounts do not support this API. */
  fetchCheckinStatus(credential: WorkBuddyCredential): Promise<{
    active: boolean;
    todayCheckedIn: boolean;
    streakDays?: number;
    dailyCredit?: number;
    todayCredit?: number;
  }>;
  /** Claim the domestic daily check-in reward after status says it is needed. */
  claimDailyCheckin(credential: WorkBuddyCredential): Promise<void>;
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
  probeEffort(credential: WorkBuddyCredential, model: string, effort: string | undefined, signal: AbortSignal): Promise<ProbeAttempt>;
}
/** Where the buddy is, and what is still claimable. */
interface WorkBuddyGrowthStatus {
  /** `idle` | `traveling` | `arrived`; anything else is an upstream surprise. */
  state: string;
  recordId?: number;
  /** Today's travel is used up (claimed or dispatched and already handled). */
  dailyLimitReached: boolean;
  /** Credit the pending trip pays on arrival; 0 when idle. */
  rewardCredit?: number;
  arriveAt?: number;
  locationName?: string;
}
/**
 * Read the growth-plan state.
 *
 * Deliberately read-only: a `GET` here is what the card polls, and it must
 * never be the call that dispatches a trip.
 */
declare function fetchGrowthStatus(credential: WorkBuddyCredential): Promise<WorkBuddyGrowthStatus>;
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
declare function fetchGrowthRewardToday(credential: WorkBuddyCredential, day: string): Promise<number | undefined>;
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
declare function runGrowthTrip(credential: WorkBuddyCredential, locationId?: number): Promise<{
  dispatched: boolean;
  claimed?: number;
  reason?: string;
}>;
//#endregion
//#region src/product-config.d.ts
/** Absolute path of the cached product configuration. */
declare function workBuddyProductConfigPath(): string;
/** One model row from the product configuration, narrowed to what is used. */
interface WorkBuddyProductModel {
  id: string;
  name: string;
  /** Credits multiplier, e.g. `"x0.00"`. Absent when the config states none. */
  credits?: string;
  contextWindow: number;
  maxTokens: number;
  supportsImages: boolean;
  supportsReasoning: boolean;
  onlyReasoning: boolean;
  supportedEfforts?: readonly WorkBuddyEffort[];
  defaultEffort?: WorkBuddyEffort;
  canDisableThinking: boolean;
}
/** The parsed slice of the product configuration this plugin consumes. */
interface WorkBuddyProductConfig {
  /** Where the data came from, for diagnostics and the settings card. */
  source: 'cache' | 'builtin';
  /** Path consulted for `cache`; absent for `builtin`. */
  path?: string;
  /** Application the config describes, e.g. `workbuddy-ai`. */
  applicationName?: string;
  /** Endpoint the config points at, e.g. `https://www.workbuddy.ai`. */
  endpoint?: string;
  /** Whether the config describes the overseas build. */
  isOversea?: boolean;
  /** Every model row, in configuration order. */
  models: readonly WorkBuddyProductModel[];
}
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
declare const BUILTIN_FREE_MODELS: readonly WorkBuddyUpstreamModel[];
/** Ids of the models the product configuration prices free. */
declare const FALLBACK_FREE_MODEL_IDS: readonly string[];
/**
 * Last-known international `credits` multipliers, used when the app cache is
 * absent. Catalog `x0.00` is not trusted (`hy4-preview` is x0.29 here).
 */
declare const BUILTIN_CREDITS: Readonly<Record<string, string>>;
/**
 * The subset the catalog endpoint does not return, so they must be injected.
 *
 * `hy3` is absent from this list because the endpoint does list it; the other
 * two are missing from the live catalog entirely.
 */
declare const FALLBACK_EXTRA_MODELS: readonly WorkBuddyUpstreamModel[];
/** Parse a product-configuration document; undefined when it is not usable. */
declare function parseProductConfig(text: string): WorkBuddyProductConfig | undefined;
/**
 * Load the product configuration, falling back to the built-in table.
 *
 * A missing or malformed cache is never an error: the plugin must still offer
 * its free models on a machine where the app has not run yet.
 */
declare function loadProductConfig(path?: string): WorkBuddyProductConfig;
/**
 * The free model ids a configuration declares.
 *
 * Only an explicit `x0.00` counts. When the cache is absent the built-in
 * whitelist applies, so the answer is never "every model" — a mis-read must not
 * be able to turn the free-only filter into a no-op.
 */
declare function freeModelIds(config: WorkBuddyProductConfig): readonly string[];
//#endregion
//#region src/catalog.d.ts
/** One model entry the adapter exposes. */
type WorkBuddyModelInfo = WorkBuddyUpstreamModel;
/** How the catalog decides which models the picker may show. */
type WorkBuddyModelScope = 'free' | 'all';
/**
 * Static rows served before the first upstream answer arrives, and whenever the
 * upstream is unreachable.
 *
 * These are the two free models the international deployment does not list in
 * its catalog endpoint, plus `hy3` which it does. Serving a usable list from the
 * first moment means an offline upstream never leaves the provider empty.
 */
declare const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[];
/** Constructor dependencies for {@link WorkBuddyCatalog}. */
interface WorkBuddyCatalogOptions {
  /** Product configuration supplying prices and the omitted-model rows. */
  productConfig: WorkBuddyProductConfig;
  /** Which models the picker may show; see {@link WorkBuddyModelScope}. */
  scope?: WorkBuddyModelScope;
  /** Keep the legacy static fallback; false prevents a region leaking another region's list. */
  fallback?: boolean;
  /** Use each region's upstream billing instead of the global product cache. */
  priceAuthority?: 'product' | 'upstream';
}
/**
 * Merge the upstream catalog with the product configuration under one billing
 * policy.
 *
 * Order of operations, each step deliberate:
 *
 * 1. Start from the upstream rows (or the fallback when there are none yet).
 * 2. Add product-config rows for free models the upstream omitted — this is what
 *    brings `deepseek-v4.1-flash` and `hy4-preview-f` into the picker.
 * 3. Overwrite each row's billing with the product configuration's verdict when
 *    it has one, so the catalog's wrong `x0.00` on a paid model cannot survive.
 * 4. Drop everything outside the policy's allow-list, *last*, so no later step
 *    can reintroduce a model the policy excluded.
 *
 * @param upstream - rows from the live catalog; empty before the first fetch.
 * @param options - product configuration and the active billing policy.
 * @returns the effective model list, upstream order first.
 */
declare function composeCatalog(upstream: readonly WorkBuddyModelInfo[], options: WorkBuddyCatalogOptions): readonly WorkBuddyModelInfo[];
/**
 * The plugin's live catalog.
 *
 * `scope` is mutable because the settings card can flip between "free only" and
 * "all models" without a restart; the adapter rebuilds its snapshot from
 * {@link current} on every read, so a change lands on the next request.
 */
declare class WorkBuddyCatalog {
  private upstream;
  private scope;
  private readonly productConfig;
  private readonly fallback;
  private readonly priceAuthority;
  /**
   * Models the user switched off in the card. Kept here rather than folded into
   * `scope` because the two answer different questions: the scope decides which
   * models are *offered*, this decides which of the offered ones the picker still
   * *lists*. Absent ids are enabled, so an install that never touched the
   * switches behaves exactly as before.
   */
  private disabled;
  constructor(options: WorkBuddyCatalogOptions);
  /** Replace the upstream rows; the effective list is recomposed immediately. */
  setUpstream(models: readonly WorkBuddyModelInfo[]): void;
  /** The upstream rows as last received, before any policy is applied. */
  upstreamModels(): readonly WorkBuddyModelInfo[];
  /** Switch the billing policy; takes effect on the next {@link current} read. */
  setScope(scope: WorkBuddyModelScope): void;
  /**
   * Replace the set of models the picker must not list.
   *
   * This never touches {@link current}: the pi-ai snapshot that resolves a
   * request is built from it, so dropping a model here would turn a switched-off
   * model into `UNKNOWN_MODEL` for a session that had already selected it. The
   * filter is applied one layer up, in the adapter's `listModels`, which is what
   * the picker reads and the request path does not.
   */
  setDisabled(ids: readonly string[]): void;
  /** The ids the picker must not list. */
  disabledIds(): readonly string[];
  /** Whether one model is switched off. */
  isDisabled(id: string): boolean;
  /** The active billing policy. */
  currentScope(): WorkBuddyModelScope;
  /** The product configuration this catalog prices against. */
  product(): WorkBuddyProductConfig;
  /** The effective entries; the fallback list until the upstream answer lands. */
  current(): readonly WorkBuddyModelInfo[];
  /** Every model in this region, before the free/all picker policy is applied. */
  all(): readonly WorkBuddyModelInfo[];
  /** Whether this region trusts upstream model billing instead of global product data. */
  usesUpstreamPricing(): boolean;
  /** Every model id this region prices as free. */
  freeIds(): readonly string[];
  /** Whether a model is free according to this region's authority. */
  isFree(id: string): boolean;
  /** Display suffix for one row: the rate, then any promotional badges. */
  displaySuffix(id: string): string | undefined;
}
//#endregion
//#region src/probe-store.d.ts
/** Basename of the probe record inside the Harness home. */
declare const WORKBUDDY_PROBE_FILENAME = ".workbuddy-ai-probe.json";
/**
 * Whether the model's effort parameter is actually validated.
 *
 * - `validating`: the upstream rejected an unknown sentinel value, so a
 *   per-level answer is meaningful.
 * - `non-validating`: the upstream accepted the sentinel, so it ignores or
 *   loosely coerces the parameter and no per-level answer can be trusted.
 * - `unknown`: baseline or sentinel failed for an unrelated reason (auth,
 *   rate limit, transport, ambiguous error body). Not a negative claim.
 */
type WorkBuddyProbeValidation = 'validating' | 'non-validating' | 'unknown';
/** One model's recorded observation. */
interface WorkBuddyProbeRecord {
  /** Fingerprint of the catalog row this observation was made against. */
  fingerprint: string;
  validation: WorkBuddyProbeValidation;
  /** Efforts verified as accepted; only ever non-empty for `validating`. */
  efforts: readonly WorkBuddyEffort[];
  /** When the probe ran, epoch milliseconds. */
  probedAtMs: number;
  /** Plugin version that produced the record. */
  pluginVersion: string;
}
/** Plugin-owned probe record path inside the Harness home. */
declare function workBuddyProbePath(): string;
/**
 * Fingerprint the catalog fields a probe depends on.
 *
 * Deliberately excludes display-only fields (`name`, `billing`, `contextWindow`)
 * so a rename or a promo badge does not throw away a valid observation, and
 * deliberately includes the whole reasoning object so any change to the
 * declared shape re-probes.
 */
declare function fingerprintModel(info: WorkBuddyModelInfo): string;
/** Options for {@link WorkBuddyProbeStore}. */
interface WorkBuddyProbeStoreOptions {
  /** Explicit state-file path, overriding the `$DSH_HOME` default. */
  path?: string;
  /** Observation lifetime; defaults to 14 days. */
  ttlMs?: number;
  /** Plugin version stamped into new records. */
  pluginVersion: string;
  /** Clock injection for tests. */
  now?: () => number;
}
/**
 * The plugin's probe records: read once, written atomically, never trusted
 * across a fingerprint change or past the TTL.
 */
declare class WorkBuddyProbeStore {
  private readonly path;
  private readonly ttlMs;
  private readonly pluginVersion;
  private readonly now;
  private records;
  constructor(options: WorkBuddyProbeStoreOptions | string);
  /** Resolved state-file path, for the CLI and tests. */
  filePath(): string;
  private load;
  /**
   * The usable record for a model, or `undefined` when there is none, it is
   * expired, or it was taken against a different catalog row.
   */
  get(modelId: string, fingerprint: string): WorkBuddyProbeRecord | undefined;
  /**
   * Store one observation. Only a decisive answer (`validating` /
   * `non-validating`) replaces an existing decisive record: a transient
   * `unknown` must not erase knowledge the user already paid for.
   */
  set(modelId: string, record: WorkBuddyProbeRecord): void;
  /** Drop every record; used by the card's explicit "clear" action. */
  clear(): void;
  /** Every record currently held, for status display. */
  all(): Readonly<Record<string, WorkBuddyProbeRecord>>;
  /** Build a record stamped with this store's clock and version. */
  record(fingerprint: string, validation: WorkBuddyProbeValidation, efforts: readonly WorkBuddyEffort[]): WorkBuddyProbeRecord;
  /**
   * Write through a temporary file and rename, so a crash mid-write cannot
   * leave a half-parsed document that reads as "no records" and silently drops
   * every observation.
   */
  private persist;
}
//#endregion
//#region src/shim.d.ts
/** Minimal logger surface the plugin context already provides. */
interface ShimLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
/** What the plugin needs from a running shim. */
interface WorkBuddyShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>;
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string;
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter resolves
   * this instead of the upstream access token, because the shim resolves the
   * real credential itself via the store.
   */
  token(): string;
  /** Stop serving and destroy open connections. */
  close(): Promise<void>;
}
/** Constructor dependencies. */
interface WorkBuddyShimOptions {
  store: WorkBuddyCredentialStoreLike;
  client: Pick<WorkBuddyUpstreamClient, 'chatStream'>;
  catalog: WorkBuddyCatalog;
  logger?: ShimLogger;
}
/**
 * Start the loopback endpoint. Requests carry the shim's own bearer; the
 * upstream credential comes from the store alone and never reaches the caller.
 */
declare function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim;
//#endregion
//#region src/adapter.d.ts
/**
 * Provider route this bundle owns.
 *
 * Distinct from the domestic plugin's `workbuddy` on purpose: both routes may be
 * mounted in one profile, and the LLM registry rejects a second adapter claiming
 * a route another already serves.
 */
declare const WORKBUDDY_PROVIDER = "workbuddy-ai";
/** Domestic route owned by this plugin; kept distinct from other WorkBuddy bundles. */
declare const WORKBUDDY_CN_PROVIDER = "workbuddy-cn";
/** Display name shown by the model picker and configuration surfaces. */
declare const WORKBUDDY_DISPLAY_NAME = "WorkBuddy";
declare const WORKBUDDY_CN_DISPLAY_NAME = "WorkBuddy 国内";
/** Constructor dependencies. */
interface WorkBuddyAdapterOptions {
  shim: WorkBuddyShim;
  store: WorkBuddyCredentialStoreLike;
  catalog: WorkBuddyCatalog;
  /** Defaults to the legacy international provider. */
  provider?: string;
  displayName?: string;
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined;
  /**
   * Look up a local probe observation for a model. Consulted only for rows the
   * upstream left undeclared; absent means declared-set-only behavior.
   */
  observe?: (modelId: string) => WorkBuddyProbeRecord | undefined;
}
/** What {@link createWorkBuddyAdapter} hands back. */
interface WorkBuddyAdapter {
  adapter: PiAiAdapter;
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void;
}
/**
 * Resolve a model's reasoning capability into pi-ai's `thinkingLevelMap` (every
 * level pinned to its wire spelling or `null` for unsupported).
 *
 * Two sources, strictly ordered:
 *
 * 1. **The declared set.** When the row declares a non-empty `supportedEfforts`,
 *    exactly those values are offered and nothing else. This always wins: an
 *    observation never widens or narrows a declared set.
 * 2. **A local observation.** A row with no declared set normally gets no
 *    control at all — its selectable set is client-side knowledge the catalog
 *    does not carry. If the user authorized a probe and it established that the
 *    upstream *validates* the parameter, the verified spellings are offered.
 *
 * A `non-validating` observation deliberately yields no control: the upstream
 * accepts values that cannot exist, so every per-level acceptance it produced
 * would be a false positive.
 *
 * `off` is offered only when the row declares `canDisableThinking: true`. It is
 * never probed — disabling thinking is a separate capability that cannot be
 * inferred from per-level acceptance.
 */
declare function reasoningFields(info: WorkBuddyModelInfo, observed?: WorkBuddyProbeRecord): {
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
};
/**
 * Assemble the adapter.
 *
 * The provider's `getModels` reads the live catalog, and every model's `baseUrl`
 * is re-resolved per read so the shim's ephemeral port applies from the first
 * snapshot after startup. The profile is constructed by hand rather than through
 * dsh-llm-pi-ai's internal `resolveProfiles()`: that helper is not part of the
 * package's public export surface, so hand-assembly is the only supported path
 * and every required field must be adopted here explicitly.
 */
declare function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions): WorkBuddyAdapter;
//#endregion
//#region src/probe-service.d.ts
/** What the caller learns about a completed probe. */
type WorkBuddyProbeStatus = {
  state: 'ok';
  validation: WorkBuddyProbeRecord['validation'];
  efforts: readonly string[];
  requests: number;
} | {
  state: 'unavailable';
  reason: string;
};
/** Options for {@link WorkBuddyProbeService}. */
interface WorkBuddyProbeServiceOptions {
  store: WorkBuddyProbeStore;
  catalog: WorkBuddyCatalog;
  credentials: WorkBuddyCredentialStoreLike;
  client: WorkBuddyUpstreamClient;
  /** Whether probing is permitted at all; consulted before every sweep. */
  consent: () => boolean;
  sentinel?: SentinelFactory;
  /** Injectable for tests; defaults to the live upstream sender. */
  send?: (modelId: string) => ProbeSender;
}
/**
 * Serial probe runner. One instance is shared by the manual API and any
 * future automatic trigger, so the two can never overlap.
 */
declare class WorkBuddyProbeService {
  private readonly options;
  private queue;
  private readonly pending;
  private running;
  constructor(options: WorkBuddyProbeServiceOptions);
  /** Whether a sweep is in flight right now. */
  isRunning(): boolean;
  /**
   * The record the adapter may use for this model, or `undefined`.
   *
   * A declared set always wins, so a model that declares `supportedEfforts` is
   * never answered from an observation.
   */
  recordFor(modelId: string): WorkBuddyProbeRecord | undefined;
  /**
   * Probe one model, serially.
   *
   * The authenticated manual route supplies one-request consent after UI
   * confirmation. Other callers must pass the configured consent gate.
   * Manual consent never changes the automatic-probing configuration.
   * Explicit requests bypass historical results, but share an ongoing run.
   */
  probe(modelId: string, manualConsent?: boolean): Promise<WorkBuddyProbeStatus>;
}
//#endregion
//#region src/oauth.d.ts
/** Give up if the browser never finishes. */
declare const LOGIN_TIMEOUT_MS: number;
/** Upstream client surface this helper needs. */
type WorkBuddyOAuthClient = Pick<WorkBuddyUpstreamClient, 'startPluginLogin' | 'pollPluginToken'>;
/** One poll tick: still waiting, or a credential ready to import. */
type WorkBuddyOAuthPoll = {
  pending: true;
} | {
  auth: WorkBuddyCredential;
};
/**
 * In-process CLI login. One instance per plugin; overlapping `start()` calls
 * replace the previous wait.
 */
declare class WorkBuddyOAuthLogin {
  private readonly client;
  private readonly open;
  private readonly region;
  private waiting;
  constructor(client: WorkBuddyOAuthClient, open?: (url: string) => boolean, region?: WorkBuddyRegion);
  /** Begin a login and try to open the browser. */
  start(): Promise<{
    authUrl: string;
    opened: boolean;
  }>;
  /**
   * One poll of the login `state`. `pending` means the user has not finished;
   * otherwise the caller must persist {@link WorkBuddyOAuthPoll.auth}.
   */
  poll(): Promise<WorkBuddyOAuthPoll>;
  /** Drop an in-flight login without touching stored credentials. */
  cancel(): void;
}
//#endregion
//#region src/host-heartbeat.d.ts
/**
 * Host-side heartbeat: a small JSON file written under `$DSH_HOME` once the
 * `workbuddy-ai` provider is registered. The status CLI reads it to report
 * whether the host bundle is alive, independent of the browser card.
 *
 * The browser (client) bundle cannot write files; its health is reported only
 * through `console.error` on failure. This asymmetry is intentional: the host is
 * the load-bearing half, and a missing heartbeat unambiguously means the host
 * never started.
 *
 * @module dsh-workbuddy/host-heartbeat
 */
/** Basename of the host heartbeat file inside the Harness home. */
declare const WORKBUDDY_HOST_HEARTBEAT_FILENAME = ".workbuddy-ai-host-heartbeat.json";
/** Package name stamped into the heartbeat, so readers can tell the two plugins apart. */
declare const HEARTBEAT_PACKAGE = "dsh-workbuddy";
/** Current on-disk heartbeat format; readers reject others. */
declare const HEARTBEAT_FORMAT_VERSION = 1;
/** On-disk shape of the heartbeat. */
interface WorkBuddyHostHeartbeat {
  version: typeof HEARTBEAT_FORMAT_VERSION;
  package: typeof HEARTBEAT_PACKAGE;
  pluginVersion: string;
  /** Epoch milliseconds when the host registered the provider. */
  registeredAt: number;
  /** Host process PID, to distinguish a stale heartbeat after a crash. */
  pid: number;
}
/** Absolute path of the host heartbeat file. */
declare function workBuddyHostHeartbeatPath(): string;
/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
declare function clearHostHeartbeat(): Promise<void>;
/** Read and validate the heartbeat; returns `undefined` when absent or malformed. */
declare function readHostHeartbeat(): Promise<WorkBuddyHostHeartbeat | undefined>;
/**
 * Absolute start time (epoch ms) of the process holding `pid`, or `undefined`
 * when it cannot be determined (no such PID, platform lacks a readable source).
 *
 * - macOS / Linux: `ps -o lstart=` prints a local-time "EEE MMM DD HH:MM:SS YYYY";
 *   `Date.parse` resolves it against the local clock, which matches how
 *   `registeredAt` (a `Date.now()` absolute value) is expressed.
 * - Windows: WMI `CreationDate` is UTC (`YYYYMMDDHHMMSS.mmm+zzzz`); parsed with
 *   `Date.UTC`, again comparable to `registeredAt`.
 *
 * Failures return `undefined` so callers can fall back to plain PID liveness
 * rather than mis-report a running host as dead.
 */
declare function processStartTimeMs(pid: number): number | undefined;
/**
 * Whether the heartbeat's PID is still alive *and* still the same process that
 * registered it. A stale heartbeat (host crashed without clearing the file) is
 * distinguished from a live host by two checks:
 *
 * 1. `process.kill(pid, 0)` — the PID exists (signal 0 tests existence).
 * 2. The process holding that PID started at or before `registeredAt`. A host
 *    that registered the heartbeat must have been started before writing it, so
 *    `start <= registeredAt`; a recycled PID belongs to an unrelated process
 *    started after the host died, so `start > registeredAt` correctly reads dead.
 *
 * PID-only detection is not enough: after a crash the OS may hand the same PID to
 * an unrelated process, and the un-cleared stale heartbeat would otherwise
 * produce a false "Host running". When the process start time cannot be read
 * (e.g. unsupported platform) the check degrades to plain PID liveness.
 */
declare function isHeartbeatProcessAlive(heartbeat: WorkBuddyHostHeartbeat): boolean;
//#endregion
//#region src/status-paths.d.ts
/**
 * Node-free constants and types shared by the Host and browser halves.
 *
 * @module dsh-workbuddy/status-paths
 */
/** Plugin-owned status endpoint consumed by its browser half. */
declare const WORKBUDDY_STATUS_PATH = "/plugins/dsh-workbuddy/status";
/**
 * Plugin-owned control endpoint.
 *
 * Separate from the status route because it accepts writes: the status route's
 * loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
 * not the same as authorizing a state-changing action. This route therefore also
 * requires the in-process key the browser half receives with the status document.
 */
declare const WORKBUDDY_CONTROL_PATH = "/plugins/dsh-workbuddy/control";
/** One model's recorded probe observation, as the card displays it. */
interface WorkBuddyWebProbeModel {
  id: string;
  name: string;
  /** `validating` results carry efforts; the other states never do. */
  validation: 'validating' | 'non-validating' | 'unknown';
  efforts: readonly string[];
  probedAt: number;
}
/** Probe section of the status document. */
interface WorkBuddyWebProbeSection {
  /** Whether the user has authorized probing. */
  consent: boolean;
  /** Whether a sweep is in flight right now. */
  running: boolean;
  /** Models the user could probe by hand (undeclared yet reasoning-capable). */
  candidates: readonly string[];
  /** Recorded observations. */
  results: readonly WorkBuddyWebProbeModel[];
}
/** One billing package and its remaining credit. */
interface WorkBuddyWebCreditAccount {
  packageName: string;
  remain: number;
  size: number;
  /** Upstream `CapacityType`: 4 = monthly plan quota, 1 = granted bonus pack. */
  capacityType: number;
  /** Epoch ms when the package expires; absent when the upstream reports none. */
  expiresAt?: number;
}
/** Aggregated credit answer rendered by the plugin card. */
interface WorkBuddyWebCredits {
  total: number;
  accounts: readonly WorkBuddyWebCreditAccount[];
}
/** Billing convenience facts for one model, rendered as card badges. */
interface WorkBuddyWebModelBadge {
  id: string;
  name: string;
  /** Whether the model is currently free (`x0.00` credits). */
  free?: boolean;
  /** Promotional badges, e.g. `限时免费`, `夜间折扣`. */
  badges?: readonly string[];
  /** Credits multiplier in display form, e.g. `x0.79`. */
  credits?: string;
  /** Context capacity in tokens, taken verbatim from the upstream catalog. */
  contextWindow?: number;
  /**
   * Whether the free-only policy currently admits this model into the picker.
   * A card needs this to explain why a listed model is not selectable.
   */
  selectable?: boolean;
  /**
   * Whether the per-model switch is on. `false` means the picker no longer
   * lists the model, though a session that already selected it keeps working.
   */
  enabled?: boolean;
}
/**
 * Which models the picker is allowed to show.
 *
 * `free` is the default: only models the product configuration prices `x0.00`.
 * `all` lifts the filter and exposes every model the account can reach, which
 * means paid models become selectable and their credit cost is real.
 */
type WorkBuddyModelScope$1 = 'free' | 'all';
/** A token-free account row shown in the region tab. */
interface WorkBuddyWebAccount {
  id: string;
  nickname?: string;
  note?: string;
  domain?: string;
  source?: 'desktop' | 'dsh';
  expiresAt?: number;
  selected: boolean;
  checkinEnabled?: boolean;
  /** Today's check-in state for this account; absent when it was never read. */
  checkin?: {
    todayCheckedIn?: boolean;
    todayCredit?: number;
    streakDays?: number;
  };
  /** Growth-plan ("小猫成长计划") state; absent when it was never read. */
  growth?: {
    state: string;
    dailyLimitReached?: boolean;
    rewardCredit?: number;
    arriveAt?: number;
    locationName?: string;
    claimedToday?: number;
  };
  /** Growth-center tasks still unclaimed today; absent when no sweep has run. */
  tasks?: {
    outstanding: number;
  };
  credits?: WorkBuddyWebCredits;
  creditsError?: string;
  connectivity?: {
    state: 'unknown' | 'checking' | 'ok' | 'error';
    checkedAt?: number;
    message?: string;
  };
}
interface WorkBuddyWebCheckin {
  supported: boolean;
  enabled: boolean;
  active?: boolean;
  todayCheckedIn?: boolean;
  streakDays?: number;
  dailyCredit?: number;
  /** What today actually paid out, which differs from `dailyCredit` on a bonus day. */
  todayCredit?: number;
  error?: string;
}
interface WorkBuddyWebRegion {
  region: 'cn' | 'global';
  signedIn: boolean;
  selectedAccountId?: string;
  accounts: readonly WorkBuddyWebAccount[];
  models?: readonly WorkBuddyWebModelBadge[];
  probe?: WorkBuddyWebProbeSection;
  scope?: WorkBuddyModelScope$1;
  freeIds?: readonly string[];
  priceSource?: 'cache' | 'builtin' | 'upstream';
  priceSourcePath?: string;
  endpoint?: string;
  checkin?: WorkBuddyWebCheckin;
}
/** The JSON document the plugin card renders. */
type WorkBuddyWebStatus = {
  status: 'signed-out';
  controlKey?: string;
  regions?: readonly WorkBuddyWebRegion[];
} | {
  status: 'signed-in';
  nickname?: string;
  domain?: string;
  source?: 'desktop' | 'dsh';
  expiresAt?: number;
  credits?: WorkBuddyWebCredits;
  creditsError?: string;
  /** Billing convenience facts for the models the plugin serves. */
  models?: readonly WorkBuddyWebModelBadge[];
  /** Reasoning-effort probe state, consent, and recorded observations. */
  probe?: WorkBuddyWebProbeSection;
  /** The active billing policy. */
  scope?: WorkBuddyModelScope$1;
  /** Model ids the product configuration prices free. */
  freeIds?: readonly string[];
  /** Where the price data came from, for the card's provenance line. */
  priceSource?: 'cache' | 'builtin' | 'upstream';
  /** Path of the product configuration when one was read. */
  priceSourcePath?: string;
  /** Endpoint the product configuration points at, e.g. `https://www.workbuddy.ai`. */
  endpoint?: string;
  /**
   * In-process key authorizing control writes. Handed to the card with the
   * status document (the card is same-origin and already had to pass the
   * loopback guard); it is never persisted and rotates per process.
   */
  controlKey?: string;
  regions?: readonly WorkBuddyWebRegion[];
  refreshPolicy?: {
    activeMinutes: number;
    inactiveMinutes: number;
  };
  autoCheckin?: boolean;
} | {
  status: 'error';
  message: string;
};
/** Action requested from the control route. */
type WorkBuddyControlAction = {
  action: 'probe';
  model: string;
} | {
  action: 'clearProbe';
} | {
  action: 'setScope';
  scope: WorkBuddyModelScope$1;
  region?: 'cn' | 'global';
} | {
  action: 'loginStart';
  region?: 'cn' | 'global';
} | {
  action: 'loginPoll';
  region?: 'cn' | 'global';
} | {
  action: 'logout';
  region?: 'cn' | 'global';
} | {
  action: 'selectAccount';
  region: 'cn' | 'global';
  accountId: string;
} | {
  action: 'removeAccount';
  region: 'cn' | 'global';
  accountId: string;
} | {
  action: 'setAccountNote';
  region: 'cn' | 'global';
  accountId: string;
  note: string;
} | {
  action: 'setCheckinEnabled';
  accountId: string;
  enabled: boolean;
} | {
  action: 'checkin';
  accountId: string;
} | {
  action: 'connectivity';
  region: 'cn' | 'global';
  accountId?: string;
} | {
  action: 'setRefreshPolicy';
  activeMinutes: number;
  inactiveMinutes: number;
} | {
  action: 'setAutoCheckin';
  enabled: boolean;
} | {
  action: 'setModelEnabled';
  model: string;
  enabled: boolean;
  region?: 'cn' | 'global';
} | {
  action: 'setModelsEnabled';
  models: readonly string[];
  enabled: boolean;
  region?: 'cn' | 'global';
};
//#endregion
//#region src/index.d.ts
/** Stable Cordis plugin name. */
declare const name = "llm-workbuddy-ai";
/** The model registry required before the provider can register. */
declare const inject: string[];
/**
 * Settings namespace owning the configuration card.
 *
 * A namespace is a nominal string, validated by the type system where it is used
 * rather than at runtime. The cast is applied once here so the public constant
 * carries the seam's type without pulling the brand helper into this package.
 */
declare const WORKBUDDY_SETTINGS_NS: SettingsNamespace;
/** Plugin configuration. */
interface Config {
  /** Explicit international WorkBuddy desktop auth-file path. */
  authFile?: string;
  /** Explicit domestic WorkBuddy desktop auth-file path. */
  cnAuthFile?: string;
  /** Active-account read-only refresh cadence in minutes. */
  refreshActiveMinutes?: number;
  /** Inactive-account read-only refresh cadence in minutes. */
  refreshInactiveMinutes?: number;
  /** Domestic daily check-in; off by default. */
  autoCheckin?: boolean;
  /**
   * Whether the user has authorized sending probe requests about reasoning
   * efforts. Off by default: a probe spends real credit, so nothing is sent until
   * the user explicitly agrees.
   */
  probeConsent?: boolean;
  /**
   * Which models the picker may show. `free` (the default) lists only models the
   * product configuration prices `x0.00`; `all` lifts the filter and makes paid
   * models selectable, so their credit cost becomes real.
   */
  modelScope?: WorkBuddyModelScope;
  /** Domestic model scope, independent from the international card. */
  cnModelScope?: WorkBuddyModelScope;
  /**
   * Model ids the picker must stop listing in the international card. Purely a
   * picker filter: an already-selected model keeps resolving and sending.
   */
  disabledModels?: string[];
  /** Same picker filter, for the domestic card. */
  cnDisabledModels?: string[];
  /**
   * Explicit product-configuration path, overriding the app's own cache
   * location. Only needed when the app keeps its state somewhere unusual.
   */
  productConfigFile?: string;
  /**
   * Extra Host/Origin authorities for the settings card when DSH Web is
   * reached over LAN (e.g. `192.168.1.10`). Empty (the default) keeps the
   * card on loopback only. Never put LAN names into the loopback set.
   */
  allowedHosts?: string[];
}
declare const Config: z<Config>;
/**
 * Start the loopback endpoint, register the `workbuddy-ai` provider, and refresh
 * the model catalog from the upstream once credentials allow it. The static
 * fallback catalog serves from the first moment, so an offline upstream never
 * leaves the provider empty.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { BUILTIN_CREDITS, BUILTIN_FREE_MODELS, Config, FALLBACK_EXTRA_MODELS, FALLBACK_FREE_MODEL_IDS, FALLBACK_WORKBUDDY_MODELS, LOGIN_TIMEOUT_MS, PROBE_EFFORT_CANDIDATES, type ProbeAttempt, type ProbeOutcome, type ProbeSender, type UpstreamErrorKind, WORKBUDDY_AUTH_FILENAME, WORKBUDDY_AUTH_FILE_ENV, WORKBUDDY_CN_AUTH_FILENAME, WORKBUDDY_CN_AUTH_FILE_ENV, WORKBUDDY_CN_DESKTOP_AUTH_BASENAME, WORKBUDDY_CN_DISPLAY_NAME, WORKBUDDY_CN_PROVIDER, WORKBUDDY_CONTROL_PATH, WORKBUDDY_DESKTOP_AUTH_BASENAME, WORKBUDDY_DISPLAY_NAME, WORKBUDDY_HOST_HEARTBEAT_FILENAME, WORKBUDDY_PROBE_FILENAME, WORKBUDDY_PROVIDER, WORKBUDDY_SETTINGS_NS, WORKBUDDY_STATUS_PATH, WorkBuddyAccountStore, type WorkBuddyAccountSummary, type WorkBuddyAdapter, type WorkBuddyAuthStatus, WorkBuddyCatalog, type WorkBuddyChatResult, type WorkBuddyControlAction, type WorkBuddyCredential, WorkBuddyCredentialStore, type WorkBuddyCredentialStoreLike, type WorkBuddyCredits, type WorkBuddyEffort, type WorkBuddyGrowthStatus, type WorkBuddyHostHeartbeat, type WorkBuddyModelBilling, type WorkBuddyModelInfo, type WorkBuddyModelReasoning, type WorkBuddyModelScope, WorkBuddyOAuthLogin, type WorkBuddyProbeRecord, WorkBuddyProbeService, type WorkBuddyProbeStatus, WorkBuddyProbeStore, type WorkBuddyProbeValidation, type WorkBuddyProductConfig, type WorkBuddyProductModel, type WorkBuddyRefreshOutcome, type WorkBuddyRegion, type WorkBuddyShim, WorkBuddyUpstreamClient, type WorkBuddyUpstreamModel, type WorkBuddyWebAccount, type WorkBuddyWebCheckin, type WorkBuddyWebModelBadge, type WorkBuddyWebProbeModel, type WorkBuddyWebProbeSection, type WorkBuddyWebRegion, type WorkBuddyWebStatus, apply, classifyUpstreamError, clearHostHeartbeat, composeCatalog, createWorkBuddyAdapter, createWorkBuddyShim, credentialFromPluginToken, defaultDesktopAuthCandidates, defaultDesktopAuthPath, fetchGrowthRewardToday, fetchGrowthStatus, fingerprintModel, freeModelIds, inject, isFreeCredits, isHeartbeatProcessAlive, loadProductConfig, name, normalizeCredits, parseProductConfig, parseWorkBuddyAuth, prepareChatBody, probeModel, processStartTimeMs, randomSentinel, readHostHeartbeat, reasoningFields, regionOf, runGrowthTrip, workBuddyHostHeartbeatPath, workBuddyOwnAuthPath, workBuddyProbePath, workBuddyProductConfigPath, workBuddyRegionOwnAuthPath };