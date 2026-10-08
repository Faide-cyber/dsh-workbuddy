/**
 * Browser OAuth for the official WorkBuddy CLI login endpoints.
 *
 * Starts a CLI login at `/v2/plugin/auth/state`, opens `authUrl`, then polls
 * `/v2/plugin/auth/token` until the user finishes in the browser (envelope
 * code `11217` means still waiting). The resulting tokens are saved through
 * {@link WorkBuddyCredentialStore.importCredential} — the desktop auth file
 * is never written.
 *
 * Login `state` stays in process memory so a same-origin card cannot resume a
 * poll it did not start.
 *
 * @module dsh-workbuddy/oauth
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { credentialFromPluginToken, type WorkBuddyCredential } from './auth.ts'
import type { WorkBuddyRegion, WorkBuddyUpstreamClient } from './upstream.ts'

/** Give up if the browser never finishes. */
export const LOGIN_TIMEOUT_MS = 15 * 60 * 1000

/** Upstream client surface this helper needs. */
export type WorkBuddyOAuthClient = Pick<WorkBuddyUpstreamClient, 'startPluginLogin' | 'pollPluginToken'>

/** One poll tick: still waiting, or a credential ready to import. */
export type WorkBuddyOAuthPoll =
  | { pending: true }
  | { auth: WorkBuddyCredential }

/**
 * Open `url` with the platform browser helper. Failures are non-fatal: the
 * caller still returns the URL so the UI can offer a link.
 */
export function openAuthUrl(url: string): boolean {
  try {
    const command = process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    // Headless Linux has no `xdg-open`. spawn's ENOENT is an async `error`
    // event — try/catch cannot see it — and an unhandled one exits the
    // whole `dsh web` process after the card already received `authUrl`.
    spawn(command, args, { detached: true, stdio: 'ignore' })
      .on('error', () => {})
      .unref()
    return true
  } catch {
    return false
  }
}

/**
 * In-process CLI login. One instance per plugin; overlapping `start()` calls
 * replace the previous wait.
 */
export class WorkBuddyOAuthLogin {
  private waiting: { state: string; authUrl: string; startedAt: number } | undefined

  constructor(
    private readonly client: WorkBuddyOAuthClient,
    private readonly open: (url: string) => boolean = openAuthUrl,
    private readonly region: WorkBuddyRegion = 'global',
  ) {}

  /** Begin a login and try to open the browser. */
  async start(): Promise<{ authUrl: string; opened: boolean }> {
    const nonce = randomBytes(16).toString('hex')
    const started = await this.client.startPluginLogin(nonce, this.region)
    this.waiting = { state: started.state, authUrl: started.authUrl, startedAt: Date.now() }
    return { authUrl: started.authUrl, opened: this.open(started.authUrl) }
  }

  /**
   * One poll of the login `state`. `pending` means the user has not finished;
   * otherwise the caller must persist {@link WorkBuddyOAuthPoll.auth}.
   */
  async poll(): Promise<WorkBuddyOAuthPoll> {
    const waiting = this.waiting
    if (waiting === undefined) throw new Error('workbuddy-ai: no login in progress')
    if (Date.now() - waiting.startedAt > LOGIN_TIMEOUT_MS) {
      this.waiting = undefined
      throw new Error('workbuddy-ai: login timed out')
    }
    const data = await this.client.pollPluginToken(waiting.state, this.region)
    if (data === undefined) return { pending: true }
    this.waiting = undefined
    return { auth: credentialFromPluginToken(data, this.region) }
  }

  /** Drop an in-flight login without touching stored credentials. */
  cancel(): void {
    this.waiting = undefined
  }
}
