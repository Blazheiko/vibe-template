import { isIP } from 'node:net'

import pushConfig from '#config/push.js'

// feat-104 (R03): the server POSTs to the endpoint a browser hands it, so only the push services
// in PUSH_ALLOWED_ENDPOINT_HOSTS are accepted: https, the default port, no credentials, no IP
// literal, and a host that is an allowed entry or a subdomain of a `.domain` entry. Checked when a
// subscription is stored and again before every send.

function normalizeHost(hostname: string): string {
    const lower = hostname.toLowerCase()
    return lower.endsWith('.') ? lower.slice(0, -1) : lower
}

function hostAllowed(host: string, allowed: readonly string[]): boolean {
    return allowed.some((entry) =>
        entry.startsWith('.') ? host.endsWith(entry) && host.length > entry.length : host === entry,
    )
}

export function isAllowedPushEndpoint(
    endpoint: string,
    allowed: readonly string[] = pushConfig.allowedEndpointHosts,
): boolean {
    let url: URL
    try {
        url = new URL(endpoint)
    } catch {
        return false
    }

    if (url.protocol !== 'https:') return false
    if (url.username !== '' || url.password !== '') return false
    // URL drops the default port, so any port left is not 443.
    if (url.port !== '') return false

    // WHATWG URL already lowercases and punycodes the host; brackets mark an IPv6 literal.
    const host = normalizeHost(url.hostname)
    if (host.startsWith('[') || isIP(host) !== 0) return false

    return hostAllowed(host, allowed)
}

/**
 * The form an endpoint is stored and looked up in (feat-125): host lowercased and without the
 * trailing dot, the default port dropped, path and query as they are. `https://FCM.GOOGLEAPIS.COM./x`
 * and `https://fcm.googleapis.com/x` reach the same push service and are one endpoint, so the
 * "belongs to another user" check sees them as one. null for an endpoint that is not allowed.
 */
export function canonicalPushEndpoint(
    endpoint: string,
    allowed: readonly string[] = pushConfig.allowedEndpointHosts,
): string | null {
    if (!isAllowedPushEndpoint(endpoint, allowed)) return null
    const url = new URL(endpoint)
    return `https://${normalizeHost(url.hostname)}${url.pathname}${url.search}`
}
