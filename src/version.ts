/**
 * Package version reported by the status CLI and written into the heartbeat.
 *
 * The value is injected at build time by tsdown's `define` (see
 * tsdown.config.ts), which replaces `__DSH_WORKBUDDY_VERSION__` with the
 * `version` field of package.json. Keeping package.json as the single source of
 * truth avoids the two-point-maintenance drift where a release bumps the npm
 * version but the code still reports the old one. The `typeof === 'string'`
 * guard keeps the bundle harmless when a build forgets to define it (it falls
 * back to a clearly-dev marker).
 *
 * @module dsh-workbuddy/version
 */

declare const __DSH_WORKBUDDY_VERSION__: string

export const WORKBUDDY_VERSION: string =
  typeof __DSH_WORKBUDDY_VERSION__ === 'string' ? __DSH_WORKBUDDY_VERSION__ : '0.0.0-dev'
