/**
 * WorkBuddy (international) credential resolution.
 *
 * Credentials come from either:
 * 1. Browser OAuth (official CLI login), saved as a plugin-owned copy under
 *    `$DSH_HOME` — this is the path that does not need the desktop app.
 * 2. The WorkBuddy **international** desktop app's own auth file, read-only;
 *    the same plugin-owned copy also holds token refreshes so the desktop file
 *    is never written.
 * The effective credential is whichever of the two expires later, so a refresh
 * by either side wins.
 *
 * International vs domestic: the two deployments write different auth files in
 * the same directory — `workbuddy-desktop-ai.info` (domain `www.workbuddy.ai`,
 * the overseas product) and `workbuddy-desktop.info` (domain `www.workbuddy.cn`,
 * the domestic one). This plugin reads the `.ai` file, because the overseas
 * deployment is the one it serves. The credential's own `domain` field is what
 * actually selects the upstream host, so a mis-pointed file degrades into a
 * region mismatch rather than silent cross-region traffic.
 *
 * @module dsh-workbuddy/auth
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir, release } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyCredits, WorkBuddyRefreshOutcome, WorkBuddyRegion } from './upstream.ts'

/** Normalized WorkBuddy credential, timestamps in epoch milliseconds. */
export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  domain: string
  uid: string
  enterpriseId?: string
  nickname?: string
  /** Which storage the credential was read from; refreshes are always `dsh`. */
  source: 'desktop' | 'dsh'
}

/** Read-only sign-in summary for status and doctor output. */
export interface WorkBuddyAuthStatus {
  state: 'signed-in' | 'signed-out'
  expiresAtMs?: number
  refreshExpiresAtMs?: number
  nickname?: string
  domain?: string
  source?: 'desktop' | 'dsh'
}

/** Constructor options; only {@link refresh} is required. */
export interface WorkBuddyStoreOptions {
  /** Explicit desktop auth-file path, overriding env and platform defaults. */
  desktopPath?: string
  /** Explicit plugin-owned copy path, defaulting under `$DSH_HOME`. */
  ownPath?: string
  /** Region used by the account-aware store; the legacy store defaults global. */
  region?: WorkBuddyRegion
  /** Performs the upstream token refresh. */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number
}

/** Basename of the plugin-owned credential copy inside the Harness home. */
export const WORKBUDDY_AUTH_FILENAME = '.workbuddy-ai-auth.json'
/** Region-scoped plugin copy for domestic credentials. */
export const WORKBUDDY_CN_AUTH_FILENAME = '.workbuddy-cn-auth.json'
/** Sidecar holding additional account identities; the legacy primary stays compatible. */
export const WORKBUDDY_ACCOUNTS_SUFFIX = '.accounts.json'

/** Env variable that overrides the desktop auth-file location. */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'
/** Domestic desktop path override. */
export const WORKBUDDY_CN_AUTH_FILE_ENV = 'WORKBUDDY_CN_AUTH_FILE'
/** Domestic desktop auth basename. */
export const WORKBUDDY_CN_DESKTOP_AUTH_BASENAME = 'workbuddy-desktop.info'

/**
 * Basename of the WorkBuddy **international** desktop auth document.
 *
 * The domestic build writes `workbuddy-desktop.info` in the same directory;
 * only the `.ai` suffix names the overseas sign-in this plugin is built for.
 */
export const WORKBUDDY_DESKTOP_AUTH_BASENAME = 'workbuddy-desktop-ai.info'

/** Current on-disk format of the plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1

interface OwnDocument {
  version: typeof OWN_FORMAT_VERSION
  credential: WorkBuddyCredential
}

/** Plugin-owned copy path inside the Harness home. */
export function workBuddyOwnAuthPath(): string {
  return join(resolveDshHome(), WORKBUDDY_AUTH_FILENAME)
}

/** Plugin-owned primary path for a region; global keeps the legacy filename. */
export function workBuddyRegionOwnAuthPath(region: WorkBuddyRegion): string {
  return join(resolveDshHome(), region === 'global' ? WORKBUDDY_AUTH_FILENAME : WORKBUDDY_CN_AUTH_FILENAME)
}

const DESKTOP_AUTH_DIRECTORY = ['CodeBuddyExtension', 'Data', 'Public', 'auth'] as const
const ACCOUNT_NOTE_MAX = 80

/** Whether this Linux process is running inside Windows Subsystem for Linux. */
function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  if (process.env['WSL_DISTRO_NAME'] !== undefined || process.env['WSL_INTEROP'] !== undefined) return true
  return release().toLowerCase().includes('microsoft')
}

/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form. */
function windowsPathForWsl(value: string | undefined): string | undefined {
  const path = value?.trim()
  if (!path) return undefined
  if (path.startsWith('/')) return path
  const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path)
  if (drivePath === null) return undefined
  return join('/mnt', drivePath[1]!.toLowerCase(), ...drivePath[2]!.split(/[\\/]+/u))
}

/** Windows desktop credential candidates visible from a WSL process. */
function wslDesktopAuthCandidates(home: string): string[] {
  const profile = windowsPathForWsl(process.env['USERPROFILE'])
    ?? join('/mnt/c/Users', basename(home))
  const localAppData = windowsPathForWsl(process.env['LOCALAPPDATA'])
    ?? join(profile, 'AppData', 'Local')
  const roamingAppData = windowsPathForWsl(process.env['APPDATA'])
    ?? join(profile, 'AppData', 'Roaming')
  return [
    join(localAppData, ...DESKTOP_AUTH_DIRECTORY, WORKBUDDY_DESKTOP_AUTH_BASENAME),
    join(roamingAppData, ...DESKTOP_AUTH_DIRECTORY, WORKBUDDY_DESKTOP_AUTH_BASENAME),
  ]
}

/**
 * Platform-default candidates for the WorkBuddy **international** desktop
 * app's auth file, in probe order. Windows probes both AppData roots: current
 * builds write under `%LOCALAPPDATA%` (Local), older ones under `%APPDATA%`
 * (Roaming). WSL probes those same Windows locations through its mounted
 * Windows profile before the native Linux location.
 */
export function defaultDesktopAuthCandidates(): string[] {
  const home = homedir()
  const name = WORKBUDDY_DESKTOP_AUTH_BASENAME
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', ...DESKTOP_AUTH_DIRECTORY, name)]
  }
  if (process.platform === 'win32') {
    return [
      join(home, 'AppData', 'Local', ...DESKTOP_AUTH_DIRECTORY, name),
      join(home, 'AppData', 'Roaming', ...DESKTOP_AUTH_DIRECTORY, name),
    ]
  }
  if (process.platform === 'linux') {
    const linux = join(home, '.config', ...DESKTOP_AUTH_DIRECTORY, name)
    return isWsl() ? [...wslDesktopAuthCandidates(home), linux] : [linux]
  }
  return []
}

/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
export function defaultDesktopAuthPath(): string | undefined {
  return defaultDesktopAuthCandidates()[0]
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function normalizeAccountNote(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const note = value.trim().replace(/\s+/gu, ' ')
  return note === '' ? undefined : note.slice(0, ACCOUNT_NOTE_MAX)
}

/**
 * Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
 * nested form `{"auth":{...},"account":{...}}` and the flat panel form.
 * Returns undefined when the document carries no access token.
 */
export function parseWorkBuddyAuth(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (typeof document['auth'] === 'object' && document['auth'] !== null) {
    auth = document['auth'] as Record<string, unknown>
    identity = typeof document['account'] === 'object' && document['account'] !== null
      ? document['account'] as Record<string, unknown>
      : {}
  } else {
    auth = document
    identity = document
  }
  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] : ''
  if (accessToken === '') return undefined
  const expiresAtMs = typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0
  const refreshExpiresAtMs = typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined
  const enterpriseId = optionalString(identity['enterpriseId'])
  const nickname = optionalString(identity['nickname'])
  return {
    accessToken,
    refreshToken: typeof auth['refreshToken'] === 'string' ? auth['refreshToken'] : '',
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(auth['domain']) ?? '',
    uid: optionalString(identity['uid']) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: 'desktop',
  }
}

/** Decode a JWT payload without verifying the signature (identity claims only). */
function jwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length < 2 || parts[1] === undefined || parts[1] === '') return undefined
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Turn the official CLI `/v2/plugin/auth/token` payload into a credential.
 * Identity fields come from the access-token JWT; the desktop file is not used.
 */
export function credentialFromPluginToken(data: Record<string, unknown>, region: WorkBuddyRegion = 'global'): WorkBuddyCredential {
  const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
  if (accessToken === '') throw new Error('workbuddy-ai plugin token missing accessToken')
  const payload = jwtPayload(accessToken) ?? {}
  const expiresIn = typeof data['expiresIn'] === 'number' ? data['expiresIn'] : 0
  const expiresAtFromJwt = typeof payload['exp'] === 'number' && payload['exp'] > 0 ? payload['exp'] * 1000 : 0
  const uid = optionalString(payload['userId'])
    ?? optionalString(payload['uid'])
    ?? optionalString(payload['sub'])
    ?? ''
  const enterpriseId = optionalString(payload['enterpriseId']) ?? optionalString(data['enterpriseId'])
  const nickname = optionalString(payload['nickname'])
    ?? optionalString(payload['name'])
    ?? optionalString(data['nickname'])
  return {
    accessToken,
    refreshToken: typeof data['refreshToken'] === 'string' ? data['refreshToken'] : '',
    expiresAtMs: expiresAtFromJwt > 0 ? expiresAtFromJwt : expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
    domain: optionalString(data['domain']) ?? (region === 'global' ? 'www.workbuddy.ai' : 'www.codebuddy.cn'),
    uid,
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: 'dsh',
  }
}

/** Serialize the plugin-owned copy. */
function ownDocument(credential: WorkBuddyCredential): OwnDocument {
  return { version: OWN_FORMAT_VERSION, credential }
}

/**
 * Parse the plugin-owned copy; other versions and shapes are rejected.
 *
 * The owned copy stores the normalized credential itself (camelCase
 * `expiresAtMs`, identity fields at the top level), not the desktop document
 * shape, so it is read field by field rather than through
 * {@link parseWorkBuddyAuth} — round-tripping would read `expiresAt` and an
 * `account` object, find neither, zero the expiry, and drop the identity
 * headers.
 */
function parseOwnDocument(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (document['version'] !== OWN_FORMAT_VERSION) return undefined
  if (typeof document['credential'] !== 'object' || document['credential'] === null) return undefined
  const stored = document['credential'] as Record<string, unknown>
  const accessToken = typeof stored['accessToken'] === 'string' ? stored['accessToken'] : ''
  if (accessToken === '') return undefined
  const refreshExpiresAtMs = typeof stored['refreshExpiresAtMs'] === 'number' ? stored['refreshExpiresAtMs'] : undefined
  const enterpriseId = optionalString(stored['enterpriseId'])
  const nickname = optionalString(stored['nickname'])
  return {
    accessToken,
    refreshToken: typeof stored['refreshToken'] === 'string' ? stored['refreshToken'] : '',
    expiresAtMs: typeof stored['expiresAtMs'] === 'number' ? stored['expiresAtMs'] : 0,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(stored['domain']) ?? '',
    uid: optionalString(stored['uid']) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: 'dsh',
  }
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Minimal store contract shared by legacy and multi-account stores. */
export interface WorkBuddyCredentialStoreLike {
  current(): Promise<WorkBuddyCredential | undefined>
  resolve(): Promise<WorkBuddyCredential>
  status(): Promise<WorkBuddyAuthStatus>
  importCredential(credential: WorkBuddyCredential): Promise<WorkBuddyCredential>
  logout(): Promise<void>
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
export class WorkBuddyCredentialStore implements WorkBuddyCredentialStoreLike {
  private readonly refresh: WorkBuddyStoreOptions['refresh']
  private readonly refreshMarginMs: number
  private readonly ownPath: string
  private desktopPathOverride: string | undefined
  private inflight: Promise<WorkBuddyCredential> | undefined

  constructor(options: WorkBuddyStoreOptions) {
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.ownPath = options.ownPath ?? workBuddyOwnAuthPath()
    this.desktopPathOverride = options.desktopPath
  }

  /**
   * Configuration precedence for the desktop file: the plugin's configured
   * path, then the environment variable, then the platform defaults. An
   * explicit path is used verbatim; the defaults are a probe order.
   */
  private resolveDesktopCandidates(): string[] {
    const fromEnv = process.env[WORKBUDDY_AUTH_FILE_ENV]
    const explicit = this.desktopPathOverride
      ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined)
    if (explicit !== undefined) return [explicit]
    return defaultDesktopAuthCandidates()
  }

  private resolveDesktopPath(): string | undefined {
    return this.resolveDesktopCandidates()[0]
  }

  /** Repoint the desktop file; a settings change applies on the next read. */
  setDesktopPath(path: string | undefined): void {
    this.desktopPathOverride = path
  }

  /** The resolved desktop auth-file path, for diagnostics. */
  desktopAuthPath(): string | undefined {
    return this.resolveDesktopPath()
  }

  /** The plugin-owned copy path, for diagnostics. */
  ownAuthPath(): string {
    return this.ownPath
  }

  /** Read the freshest stored credential without refreshing anything. */
  async current(): Promise<WorkBuddyCredential | undefined> {
    const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()])
    if (desktop === undefined) return own
    if (own === undefined) return desktop
    return own.expiresAtMs > desktop.expiresAtMs ? own : desktop
  }

  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh.
   */
  async resolve(): Promise<WorkBuddyCredential> {
    const credential = await this.current()
    if (credential === undefined) {
      const candidates = this.resolveDesktopCandidates()
      const desktop = candidates.length > 0 ? candidates.join(' or ') : '(no desktop path on this platform)'
      throw new Error(
        'workbuddy-ai: no signed-in WorkBuddy (international) account found;'
        + ' connect from the plugin card, run `dsh-workbuddy login`,'
        + ` or sign in once in the WorkBuddy international desktop app (expected ${desktop}`
        + ` or ${WORKBUDDY_AUTH_FILE_ENV})`,
      )
    }
    if (!this.needsRefresh(credential)) return credential
    this.inflight ??= this.refreshNow(credential)
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /** Read-only sign-in summary; never refreshes and never throws. */
  async status(): Promise<WorkBuddyAuthStatus> {
    try {
      const credential = await this.current()
      if (credential === undefined) return { state: 'signed-out' }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
        ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
        ...credential.domain === '' ? {} : { domain: credential.domain },
        source: credential.source,
      }
    } catch {
      return { state: 'signed-out' }
    }
  }

  /** Remove the plugin-owned copy; the desktop file is untouched. */
  async logout(): Promise<void> {
    await rm(this.ownPath, { force: true })
    await rm(`${this.ownPath}.lock`, { force: true })
  }

  /** Persist a browser-OAuth credential into the plugin-owned copy. */
  async importCredential(credential: WorkBuddyCredential): Promise<WorkBuddyCredential> {
    const next: WorkBuddyCredential = {
      ...credential,
      source: 'dsh',
      domain: credential.domain === '' ? 'www.workbuddy.ai' : credential.domain,
    }
    await this.saveOwn(next)
    return next
  }

  private needsRefresh(credential: WorkBuddyCredential): boolean {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  private async refreshNow(credential: WorkBuddyCredential): Promise<WorkBuddyCredential> {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        'workbuddy-ai: access token expired and no refresh token is stored;'
        + ' connect again from the plugin card or sign in in the WorkBuddy international desktop app',
      )
    }
    try {
      const outcome = await this.refresh(credential)
      const refreshed: WorkBuddyCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs: outcome.expiresInSec !== undefined
          ? Date.now() + outcome.expiresInSec * 1000
          : credential.expiresAtMs,
        ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
        source: 'dsh',
      }
      await this.saveOwn(refreshed)
      return refreshed
    } catch (error: unknown) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        `workbuddy-ai: token refresh failed and the access token is expired (${String(error)});`
        + ' connect again from the plugin card or open the WorkBuddy international desktop app',
      )
    }
  }

  private async saveOwn(credential: WorkBuddyCredential): Promise<void> {
    await withFileLock(this.ownPath, async () => {
      await writeFileAtomic(this.ownPath, `${JSON.stringify(ownDocument(credential), null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  }

  /**
   * Read the first desktop candidate that exists. Only an absent file (ENOENT)
   * falls through to the next candidate; a file that is present but unparsable
   * is authoritative for its slot, so a stale older-version file never silently
   * wins over a broken newer one.
   */
  private async readDesktop(): Promise<WorkBuddyCredential | undefined> {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      try {
        return parseWorkBuddyAuth(await readFile(desktopPath, 'utf8'))
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
      }
    }
    return undefined
  }

  private async readOwn(): Promise<WorkBuddyCredential | undefined> {
    try {
      return parseOwnDocument(await readFile(this.ownPath, 'utf8'))
    } catch (error: unknown) {
      if (isENOENT(error)) return undefined
      return undefined
    }
  }

  /** Whether any desktop-file candidate exists as a regular file; diagnostics only. */
  async desktopFilePresent(): Promise<boolean> {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      try {
        if ((await stat(desktopPath)).isFile()) return true
      } catch {
        // absent or not a regular file — try the next candidate
      }
    }
    return false
  }
}

/** Token-free account row exposed to the settings card. */
export interface WorkBuddyAccountSummary {
  id: string
  region: WorkBuddyRegion
  nickname?: string
  note?: string
  domain?: string
  source: 'desktop' | 'dsh'
  expiresAtMs: number
  selected: boolean
  checkinEnabled: boolean
}

export interface WorkBuddyCreditSnapshot {
  credits?: WorkBuddyCredits
  error?: string
  checkedAt: number
}

interface AccountRecord {
  id: string
  credential: WorkBuddyCredential
  note?: string
  checkinEnabled: boolean
}

interface AccountsDocument {
  version: 1
  selectedAccountId?: string
  accounts: AccountRecord[]
}

/** Stable, token-free identity. A token is only hashed and never persisted in this id. */
function defaultRegionDomain(region: WorkBuddyRegion): string {
  return region === 'global' ? 'www.workbuddy.ai' : 'www.codebuddy.cn'
}

function normalizeRegionCredential(region: WorkBuddyRegion, credential: WorkBuddyCredential): WorkBuddyCredential {
  return { ...credential, domain: defaultRegionDomain(region) }
}

function accountIdFor(region: WorkBuddyRegion, credential: WorkBuddyCredential): string {
  const identity = credential.uid.trim() !== ''
    ? credential.uid.trim()
    : `${credential.domain}:${credential.accessToken}`
  return `${region}-${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`
}

function parseStoredCredential(value: unknown): WorkBuddyCredential | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const stored = value as Record<string, unknown>
  const accessToken = typeof stored['accessToken'] === 'string' ? stored['accessToken'] : ''
  if (accessToken === '') return undefined
  const source = stored['source'] === 'desktop' ? 'desktop' : 'dsh'
  return {
    accessToken,
    refreshToken: typeof stored['refreshToken'] === 'string' ? stored['refreshToken'] : '',
    expiresAtMs: typeof stored['expiresAtMs'] === 'number' ? stored['expiresAtMs'] : 0,
    ...typeof stored['refreshExpiresAtMs'] === 'number' ? { refreshExpiresAtMs: stored['refreshExpiresAtMs'] } : {},
    domain: typeof stored['domain'] === 'string' ? stored['domain'] : '',
    uid: typeof stored['uid'] === 'string' ? stored['uid'] : '',
    ...typeof stored['enterpriseId'] === 'string' ? { enterpriseId: stored['enterpriseId'] } : {},
    ...typeof stored['nickname'] === 'string' ? { nickname: stored['nickname'] } : {},
    source,
  }
}

/**
 * Region-aware, multi-account store. The legacy primary file remains in its
 * version-1 shape for CLI/backward compatibility; additional accounts live in a
 * token-bearing sidecar owned by this plugin only.
 */
export class WorkBuddyAccountStore implements WorkBuddyCredentialStoreLike {
  private readonly accountRefresh: WorkBuddyStoreOptions['refresh']
  private readonly accountRefreshMarginMs: number
  private readonly region: WorkBuddyRegion
  private readonly accountOwnPath: string
  private readonly accountsPath: string
  private desktopPathOverride: string | undefined
  private selectedAccountId: string | undefined
  private records: AccountRecord[] | undefined
  private inflight = new Map<string, Promise<WorkBuddyCredential>>()
  private creditSnapshots = new Map<string, WorkBuddyCreditSnapshot>()
  private creditInflight = new Map<string, Promise<void>>()

  constructor(options: WorkBuddyStoreOptions) {
    this.accountRefresh = options.refresh
    this.accountRefreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.region = options.region ?? 'global'
    this.accountOwnPath = options.ownPath ?? workBuddyRegionOwnAuthPath(this.region)
    this.accountsPath = `${this.accountOwnPath}${WORKBUDDY_ACCOUNTS_SUFFIX}`
    this.desktopPathOverride = options.desktopPath
  }

  accountRegion(): WorkBuddyRegion { return this.region }

  private desktopBasename(): string {
    return this.region === 'global' ? WORKBUDDY_DESKTOP_AUTH_BASENAME : WORKBUDDY_CN_DESKTOP_AUTH_BASENAME
  }

  private desktopEnv(): string {
    return this.region === 'global' ? WORKBUDDY_AUTH_FILE_ENV : WORKBUDDY_CN_AUTH_FILE_ENV
  }

  private desktopCandidates(): string[] {
    const fromEnv = process.env[this.desktopEnv()]
    const explicit = this.desktopPathOverride ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined)
    if (explicit !== undefined) return [explicit]
    if (this.region === 'global') return defaultDesktopAuthCandidates()
    const basenameToReplace = WORKBUDDY_DESKTOP_AUTH_BASENAME
    return defaultDesktopAuthCandidates().map(path => path.endsWith(basenameToReplace)
      ? `${path.slice(0, -basenameToReplace.length)}${this.desktopBasename()}`
      : path)
  }

  setDesktopPath(path: string | undefined): void { this.desktopPathOverride = path }
  desktopAuthPath(): string | undefined { return this.desktopCandidates()[0] }
  ownAuthPath(): string { return this.accountOwnPath }
  accountsAuthPath(): string { return this.accountsPath }

  private async readAccounts(): Promise<AccountRecord[]> {
    if (this.records !== undefined) return this.records
    const records = new Map<string, AccountRecord>()
    try {
      const parsed: unknown = JSON.parse(await readFile(this.accountsPath, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const doc = parsed as Record<string, unknown>
        if (doc['version'] === 1 && Array.isArray(doc['accounts'])) {
          for (const raw of doc['accounts']) {
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
            const wrapped = raw as Record<string, unknown>
            const parsedCredential = parseStoredCredential(wrapped['credential'])
            if (parsedCredential === undefined) continue
            const credential = normalizeRegionCredential(this.region, parsedCredential)
            const id = typeof wrapped['id'] === 'string' && wrapped['id'] !== ''
              ? wrapped['id'] : accountIdFor(this.region, credential)
            const note = normalizeAccountNote(wrapped['note'])
             records.set(id, {
               id,
               credential,
               ...note === undefined ? {} : { note },
               checkinEnabled: wrapped['checkinEnabled'] === true,
             })
          }
          if (typeof doc['selectedAccountId'] === 'string') this.selectedAccountId = doc['selectedAccountId']
        }
      }
    } catch {
      // A missing/corrupt sidecar is recoverable from the primary/desktop files.
    }
    const primary = await this.readPrimary()
    if (primary !== undefined) {
      const id = accountIdFor(this.region, primary)
      records.set(id, records.get(id) ?? { id, credential: primary, checkinEnabled: false })
      if (this.selectedAccountId === undefined) this.selectedAccountId = id
    }
    const desktop = await this.readDesktopCredential()
    if (desktop !== undefined) {
      const id = accountIdFor(this.region, desktop)
      records.set(id, records.get(id) ?? { id, credential: desktop, checkinEnabled: false })
      if (this.selectedAccountId === undefined) this.selectedAccountId = id
    }
    this.records = [...records.values()]
    return this.records
  }

  private async readPrimary(): Promise<WorkBuddyCredential | undefined> {
    try {
      const parsed = parseStoredCredential((JSON.parse(await readFile(this.accountOwnPath, 'utf8')) as Record<string, unknown>)['credential'])
      return parsed === undefined ? undefined : normalizeRegionCredential(this.region, parsed)
    } catch {
      return undefined
    }
  }

  private async readDesktopCredential(): Promise<WorkBuddyCredential | undefined> {
    for (const path of this.desktopCandidates()) {
      try {
        const parsed = parseWorkBuddyAuth(await readFile(path, 'utf8'))
        return parsed === undefined ? undefined : normalizeRegionCredential(this.region, parsed)
      } catch (error: unknown) { if (!isENOENT(error)) continue }
    }
    return undefined
  }

  private async persist(): Promise<void> {
    const records = this.records ?? []
    await withFileLock(this.accountOwnPath, async () => {
      if (records.length === 0) {
        await rm(this.accountOwnPath, { force: true })
        await rm(this.accountsPath, { force: true })
        return
      }
      const selected = records.find(record => record.id === this.selectedAccountId) ?? records[0]
      this.selectedAccountId = selected?.id
      await writeFileAtomic(this.accountOwnPath, `${JSON.stringify({ version: 1, credential: selected?.credential }, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
      const document: AccountsDocument = {
        version: 1,
        ...this.selectedAccountId === undefined ? {} : { selectedAccountId: this.selectedAccountId },
        accounts: records,
      }
      await writeFileAtomic(this.accountsPath, `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  }

  private needsRefresh(credential: WorkBuddyCredential): boolean {
    // An access-token-only import has no safe refresh path; let the upstream
    // reject it when it expires instead of refusing to use it pre-emptively.
    if (credential.refreshToken === '') return false
    return credential.expiresAtMs <= 0 || Date.now() + this.accountRefreshMarginMs >= credential.expiresAtMs
  }

  private async refreshAccount(record: AccountRecord): Promise<WorkBuddyCredential> {
    const current = record.credential
    if (current.refreshToken === '' && current.expiresAtMs > Date.now() + 30_000) return current
    if (current.refreshToken === '') throw new Error('workbuddy-ai: access token expired and no refresh token is stored; connect again')
    const outcome = await this.accountRefresh(current)
    const next: WorkBuddyCredential = {
      ...current,
      accessToken: outcome.accessToken,
      ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
      expiresAtMs: outcome.expiresInSec !== undefined ? Date.now() + outcome.expiresInSec * 1000 : current.expiresAtMs,
      ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
      source: 'dsh',
    }
    const normalized = normalizeRegionCredential(this.region, next)
    record.credential = normalized
    await this.persist()
    return normalized
  }

  async accounts(): Promise<readonly WorkBuddyAccountSummary[]> {
    const records = await this.readAccounts()
    return records.map(record => ({
      id: record.id,
      region: this.region,
      ...record.credential.nickname === undefined ? {} : { nickname: record.credential.nickname },
      ...record.note === undefined ? {} : { note: record.note },
       ...record.credential.domain === '' ? {} : { domain: record.credential.domain },
      source: record.credential.source,
      expiresAtMs: record.credential.expiresAtMs,
      selected: record.id === this.selectedAccountId,
      checkinEnabled: record.checkinEnabled,
    }))
  }

  async current(): Promise<WorkBuddyCredential | undefined> {
    const records = await this.readAccounts()
    const selected = records.find(record => record.id === this.selectedAccountId)
    return selected?.credential ?? records[0]?.credential
  }

  async credentialFor(accountId: string): Promise<WorkBuddyCredential | undefined> {
    const records = await this.readAccounts()
    return records.find(record => record.id === accountId)?.credential
  }

  selectedId(): string | undefined { return this.selectedAccountId }

  async resolveFor(accountId: string): Promise<WorkBuddyCredential> {
    const records = await this.readAccounts()
    const record = records.find(item => item.id === accountId)
    if (record === undefined) throw new Error('workbuddy-ai: account not found')
    if (!this.needsRefresh(record.credential)) return record.credential
    const running = this.inflight.get(accountId)
    if (running !== undefined) return running
    const promise = this.refreshAccount(record).finally(() => this.inflight.delete(accountId))
    this.inflight.set(accountId, promise)
    return promise
  }

  async resolve(): Promise<WorkBuddyCredential> {
    const current = await this.current()
    if (current === undefined) throw new Error('workbuddy-ai: no signed-in account found; connect from the plugin card')
    const id = accountIdFor(this.region, current)
    return this.resolveFor(id)
  }

  async status(): Promise<WorkBuddyAuthStatus> {
    const current = await this.current()
    if (current === undefined) return { state: 'signed-out' }
    return {
      state: 'signed-in',
      expiresAtMs: current.expiresAtMs,
      ...current.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: current.refreshExpiresAtMs },
      ...current.nickname === undefined ? {} : { nickname: current.nickname },
      ...current.domain === '' ? {} : { domain: current.domain },
      source: current.source,
    }
  }

  async refreshCreditSnapshots(
    fetchCredits: (credential: WorkBuddyCredential) => Promise<WorkBuddyCredits>,
    activeIntervalMs: number,
    inactiveIntervalMs: number,
  ): Promise<ReadonlyMap<string, WorkBuddyCreditSnapshot>> {
    const records = await this.readAccounts()
    const now = Date.now()
    for (const record of records) {
      const previous = this.creditSnapshots.get(record.id)
      const interval = record.id === this.selectedAccountId ? activeIntervalMs : inactiveIntervalMs
      if (previous !== undefined && now - previous.checkedAt < interval) continue
      const running = this.creditInflight.get(record.id)
      if (running !== undefined) {
        await running
        continue
      }
      const refresh = (async (): Promise<void> => {
        try {
          const credential = await this.resolveFor(record.id)
          const credits = await fetchCredits(credential)
          this.creditSnapshots.set(record.id, { credits, checkedAt: Date.now() })
        } catch (error: unknown) {
          this.creditSnapshots.set(record.id, { error: String(error).slice(0, 300), checkedAt: Date.now() })
        }
      })()
      this.creditInflight.set(record.id, refresh)
      try {
        await refresh
      } finally {
        this.creditInflight.delete(record.id)
      }
    }
    return this.creditSnapshots
  }

  creditSnapshot(accountId: string): WorkBuddyCreditSnapshot | undefined {
    return this.creditSnapshots.get(accountId)
  }

  async select(accountId: string): Promise<void> {
    const records = await this.readAccounts()
    if (!records.some(record => record.id === accountId)) throw new Error('workbuddy-ai: account not found')
    this.selectedAccountId = accountId
    await this.persist()
  }

  async importCredential(credential: WorkBuddyCredential, accountId?: string): Promise<WorkBuddyCredential> {
    const next = normalizeRegionCredential(this.region, {
      ...credential,
      source: 'dsh',
    })
    const records = await this.readAccounts()
    const id = accountId ?? accountIdFor(this.region, next)
    const existing = records.find(record => record.id === id)
    if (existing === undefined) records.push({ id, credential: next, checkinEnabled: false })
    else existing.credential = next
    this.selectedAccountId = id
    await this.persist()
    return next
  }

  async setCheckinEnabled(accountId: string, enabled: boolean): Promise<void> {
    const records = await this.readAccounts()
    const record = records.find(item => item.id === accountId)
    if (record === undefined) throw new Error('workbuddy-ai: account not found')
    record.checkinEnabled = enabled
    await this.persist()
  }

  /** Store a note and return the normalized value kept, or undefined when cleared. */
  async setNote(accountId: string, note: string): Promise<string | undefined> {
    const records = await this.readAccounts()
    const record = records.find(item => item.id === accountId)
    if (record === undefined) throw new Error('workbuddy-ai: account not found')
    const normalized = normalizeAccountNote(note)
    if (normalized === undefined) delete record.note
    else record.note = normalized
    await this.persist()
    return normalized
  }

  async removeAccount(accountId: string): Promise<void> {
    const records = await this.readAccounts()
    const kept = records.filter(record => record.id !== accountId)
    if (kept.length === records.length) return
    this.records = kept
    this.selectedAccountId = kept[0]?.id
    await this.persist()
  }

  /** Existing logout semantics: remove all plugin-owned credentials, never desktop auth. */
  async logout(): Promise<void> {
    this.records = []
    this.selectedAccountId = undefined
    await rm(this.accountOwnPath, { force: true })
    await rm(this.accountsPath, { force: true })
    await rm(`${this.accountOwnPath}.lock`, { force: true })
  }
}
