import appConfig from '#config/app.js'
import { networkConfig } from '#config/network.js'
import type { HttpRequest, HttpResponse } from '#vendor/start/server.js'
import { ab2str } from '#vendor/utils/helpers/ab2str.js'
import { isIpInCidr, normalizeIp } from './ip-address.js'

function isTrustedProxy(ip: string): boolean {
    return (
        networkConfig.trustProxy &&
        networkConfig.trustedProxyCidrs.some((cidr) => isIpInCidr(ip, cidr))
    )
}

function parseForwardedChain(xForwardedFor: string, remoteIp: string): string[] {
    const forwardedIps = xForwardedFor
        .split(',')
        .map((entry) => normalizeIp(entry))
        .filter((entry): entry is string => entry !== null)

    return [...forwardedIps, remoteIp]
}

function resolveClientIpFromChain(chain: readonly string[]): string | null {
    for (let index = chain.length - 1; index >= 0; index -= 1) {
        const candidate = chain[index]
        if (candidate === undefined) continue
        if (!isTrustedProxy(candidate)) {
            return candidate
        }
    }

    return null
}

// feat-110: behind a reverse proxy on a unix socket the peer has no address. Only when the server
// really listens on APP_UNIX_PATH and TRUST_UNIX_SOCKET_PROXY says the socket is the proxy's, the
// client comes from the proxy's headers; an empty address by itself proves nothing.
function fromUnixSocketProxy(req: HttpRequest): string {
    const xForwardedFor = req.getHeader('x-forwarded-for')
    if (xForwardedFor !== '') {
        const forwarded = xForwardedFor
            .split(',')
            .map((entry) => normalizeIp(entry))
            .filter((entry): entry is string => entry !== null)
        const resolved = resolveClientIpFromChain(forwarded)
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

    const xForwardedFor = req.getHeader('x-forwarded-for')
    if (xForwardedFor !== '') {
        const resolvedFromForwarded = resolveClientIpFromChain(
            parseForwardedChain(xForwardedFor, remoteIp),
        )
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
}
