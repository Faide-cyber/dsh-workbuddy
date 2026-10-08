/**
 * Shared request gates for the plugin's local HTTP surfaces: the loopback shim
 * and the same-origin web-status / control routes. Default is loopback-only.
 * Operators may add extra Host/Origin authorities for LAN DSH Web without
 * folding those names into {@link LOOPBACK_HOSTS}.
 *
 * @module dsh-workbuddy/loopback
 */

/** Loopback hostnames a local plugin surface may be addressed by. */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
export function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  // Only `name:port` with a single colon is a port; anything with more colons is
  // an (unbracketed) IPv6 literal and must not be truncated.
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && !hostname.slice(0, colon).includes(':') && /^\d+$/.test(hostname.slice(colon + 1))) {
    hostname = hostname.slice(0, colon)
  }
  return hostname
}

/**
 * The request's Host header must name the loopback interface. A DNS-rebinding
 * page (attacker domain re-resolved to 127.0.0.1) sends its own domain in Host,
 * so this check drops those before any routing happens.
 */
export function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/**
 * A browser-sent Origin (present header) must be loopback. Non-browser clients
 * (the plugin's own fetch calls) send no Origin at all and pass.
 */
export function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/** Lowercase hostname from a configured authority (`host` or `host:port`). */
export function normalizeAllowedHost(value: string): string {
  return hostnameOfHost(value.trim().toLowerCase())
}

/**
 * Host is trusted when it is loopback, or an explicitly configured extra
 * authority. Extra hosts are never folded into {@link LOOPBACK_HOSTS}: listing
 * a LAN IP there would also accept DNS-rebinding pages that spoof that Host.
 */
export function hostIsTrusted(host: string | undefined, allowedHosts: readonly string[] = []): boolean {
  if (hostIsLoopback(host)) return true
  if (host === undefined || host.trim() === '') return false
  const name = hostnameOfHost(host)
  return allowedHosts.some(entry => normalizeAllowedHost(entry) === name)
}

/**
 * Origin is trusted when absent (non-browser), loopback, or an extra host the
 * operator listed. A present Origin from an unlisted host is rejected.
 */
export function originIsTrusted(origin: string | undefined, allowedHosts: readonly string[] = []): boolean {
  if (originIsLoopback(origin)) return true
  try {
    const { hostname } = new URL(origin ?? '')
    const name = hostname === '::1' ? '[::1]' : hostname.toLowerCase()
    return allowedHosts.some(entry => {
      const allowed = normalizeAllowedHost(entry)
      return allowed === name || allowed === hostname.toLowerCase()
    })
  } catch {
    return false
  }
}

/** Combined Host + Origin gate used by the card's status and control routes. */
export function requestIsTrusted(
  req: { headers: { host?: string; origin?: string } },
  allowedHosts: readonly string[] = [],
): boolean {
  return hostIsTrusted(req.headers.host, allowedHosts) && originIsTrusted(req.headers.origin, allowedHosts)
}
