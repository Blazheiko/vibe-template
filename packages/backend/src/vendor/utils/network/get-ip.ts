import appConfig from '#config/app.js'
import { networkConfig } from '#config/network.js'
import type { HttpRequest, HttpResponse } from '#vendor/start/server.js'
import { ab2str } from '#vendor/utils/helpers/ab2str.js'
import { isIpInCidr, normalizeIp } from './ip-address.js'

// TRUSTED_PROXY_CIDRS: the hops of the chain that are our proxies. On TCP they count only with
// TRUST_PROXY=true; on the unix socket (feat-122, L8) TRUST_UNIX_SOCKET_PROXY is the switch, and
// the CIDRs name the proxies in front of the socket's proxy (a CDN, a load balancer).
function inTrustedCidrs(ip: string): boolean {
    return networkConfig.trustedProxyCidrs.some((cidr) => isIpInCidr(ip, cidr))
}

function isTrustedProxy(ip: string): boolean {
    return networkConfig.trustProxy && inTrustedCidrs(ip)
}

/**
 * One X-Forwarded-For entry: an address, also with the port some proxies append (`1.2.3.4:5678`,
 * `[2001:db8::1]:443`). null for anything else.
 */
function parseForwardedEntry(entry: string): string | null {
    const trimmed = entry.trim()
    const v4WithPort = /^(\d+\.\d+\.\d+\.\d+):\d{1,5}$/.exec(trimmed)
    if (v4WithPort?.[1] !== undefined) return normalizeIp(v4WithPort[1])
    const v6WithPort = /^\[([^\]]+)\]:\d{1,5}$/.exec(trimmed)
    if (v6WithPort?.[1] !== undefined) return normalizeIp(v6WithPort[1])
    return normalizeIp(trimmed)
}

/** The chain, left to right; an entry that is not an address stays as null. */
function parseForwardedChain(xForwardedFor: string): (string | null)[] {
    return xForwardedFor.split(',').map(parseForwardedEntry)
}

/**
 * The client: the rightmost hop that is not a trusted proxy. feat-122 (L7): the walk stops at an
 * entry it cannot read. Everything left of it was written by whoever sent that entry, so it proves
 * nothing; skipping it would let a forged leftmost entry win. null then, and the caller falls back.
 */
function resolveClientIpFromChain(
    chain: readonly (string | null)[],
    trusted: (ip: string) => boolean = isTrustedProxy,
): string | null {
    for (let index = chain.length - 1; index >= 0; index -= 1) {
        const candidate = chain[index]
        if (candidate === undefined || candidate === null) return null
        if (!trusted(candidate)) {
            return candidate
        }
    }

    return null
}

// feat-130: uWS `getHeader` returns only the first line of a repeated header. A proxy that adds
// its own X-Forwarded-For line instead of appending to the client's (HAProxy `option forwardfor`)
// would leave the client's line, which it can forge, as the whole chain. Lines are joined in
// order, as RFC 9110 §5.3 combines them.
function forwardedFor(req: HttpRequest): string {
    const lines: string[] = []
    req.forEach((key, value) => {
        if (key === 'x-forwarded-for') lines.push(value)
    })
    return lines.join(', ')
}

// feat-110: behind a reverse proxy on a unix socket the peer has no address. Only when the server
// really listens on APP_UNIX_PATH and TRUST_UNIX_SOCKET_PROXY says the socket is the proxy's, the
// client comes from the proxy's headers; an empty address by itself proves nothing.
function fromUnixSocketProxy(req: HttpRequest): string {
    const xForwardedFor = forwardedFor(req)
    if (xForwardedFor !== '') {
        const resolved = resolveClientIpFromChain(
            parseForwardedChain(xForwardedFor),
            inTrustedCidrs,
        )
        if (resolved !== null) return resolved
    }
    return normalizeIp(req.getHeader('x-real-ip')) ?? 'unknown'
}

export default (req: HttpRequest, res: HttpResponse): string => {
    const remoteIp = normalizeIp(ab2str(res.getRemoteAddressAsText()))
    if (remoteIp === null) {
        return appConfig.unixPath !== undefined && networkConfig.trustUnixSocketProxy
            ? fromUnixSocketProxy(req)
            : 'unknown'
    }
    if (!networkConfig.trustProxy || !isTrustedProxy(remoteIp)) {
        return remoteIp
    }

    const xForwardedFor = forwardedFor(req)
    if (xForwardedFor !== '') {
        const resolvedFromForwarded = resolveClientIpFromChain([
            ...parseForwardedChain(xForwardedFor),
            remoteIp,
        ])
        if (resolvedFromForwarded !== null) {
            return resolvedFromForwarded
        }
    }

    const xRealIp = normalizeIp(req.getHeader('x-real-ip'))
    if (xRealIp !== null) {
        return xRealIp
    }

    return remoteIp
}

export const __testables__ = {
    normalizeIp,
    isIpInCidr,
    resolveClientIpFromChain,
    parseForwardedChain,
}
