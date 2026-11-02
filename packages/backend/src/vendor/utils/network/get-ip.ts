import { isIP } from 'node:net'
import { networkConfig } from '#config/network.js'
import type { HttpRequest, HttpResponse } from '#vendor/start/server.js'
import { ab2str } from '#vendor/utils/helpers/ab2str.js'

function normalizeIp(value: string): string | null {
    const trimmed = value.trim()
    if (trimmed === '') {
        return null
    }

    const withoutBrackets =
        trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
    const lower = withoutBrackets.toLowerCase()
    const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
    const normalized = mappedV4?.[1] ?? lower

    return isIP(normalized) === 0 ? null : normalized
}

function parseIPv4ToBigInt(ip: string): bigint {
    return ip.split('.').reduce((acc, octet) => (acc << 8n) + BigInt(Number(octet)), 0n)
}

function parseIPv6ToBigInt(ip: string): bigint {
    const normalized = ip.toLowerCase()
    const hasEmbeddedV4 = normalized.includes('.')

    let working = normalized
    if (hasEmbeddedV4) {
        const lastColon = working.lastIndexOf(':')
        const ipv4Part = working.slice(lastColon + 1)
        const ipv4Octets = ipv4Part.split('.').map((octet) => Number(octet))
        const octet0 = ipv4Octets[0] ?? 0
        const octet1 = ipv4Octets[1] ?? 0
        const octet2 = ipv4Octets[2] ?? 0
        const octet3 = ipv4Octets[3] ?? 0
        const high = ((octet0 << 8) | octet1).toString(16)
        const low = ((octet2 << 8) | octet3).toString(16)
        working = `${working.slice(0, lastColon)}:${high}:${low}`
    }

    const [headRaw, tailRaw] = working.split('::')
    const head = headRaw === '' || headRaw === undefined ? [] : headRaw.split(':')
    const tail = tailRaw === '' || tailRaw === undefined ? [] : tailRaw.split(':')
    const missing = 8 - (head.length + tail.length)
    const groups = working.includes('::')
        ? [...head, ...Array<string>(Math.max(missing, 0)).fill('0'), ...tail]
        : head

    if (groups.length !== 8) {
        throw new Error(`Invalid IPv6 address: ${ip}`)
    }

    return groups.reduce(
        (acc, group) => (acc << 16n) + BigInt(parseInt(group === '' ? '0' : group, 16)),
        0n,
    )
}

interface ParsedIp {
    family: 4 | 6
    value: bigint
}

function parseIp(ip: string): ParsedIp | null {
    const normalized = normalizeIp(ip)
    if (normalized === null) {
        return null
    }

    const family = isIP(normalized)
    if (family === 4) {
        return { family: 4, value: parseIPv4ToBigInt(normalized) }
    }
    if (family === 6) {
        return { family: 6, value: parseIPv6ToBigInt(normalized) }
    }

    return null
}

function isIpInCidr(ip: string, cidr: string): boolean {
    const [networkRaw, prefixRaw] = cidr.split('/')
    const network = networkRaw ?? ''
    if (prefixRaw === undefined) {
        const normalizedIp = normalizeIp(ip)
        const normalizedNetwork = normalizeIp(network)
        return normalizedIp !== null && normalizedIp === normalizedNetwork
    }

    const parsedIp = parseIp(ip)
    const parsedNetwork = parseIp(network)
    if (parsedIp === null || parsedNetwork === null) {
        return false
    }
    if (parsedIp.family !== parsedNetwork.family) {
        return false
    }

    const maxBits = parsedIp.family === 4 ? 32 : 128
    const prefix = Number(prefixRaw)
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxBits) {
        return false
    }

    const shift = BigInt(maxBits - prefix)
    const ipNetwork = shift === 0n ? parsedIp.value : (parsedIp.value >> shift) << shift
    const cidrNetwork = shift === 0n ? parsedNetwork.value : (parsedNetwork.value >> shift) << shift
    return ipNetwork === cidrNetwork
}

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

export default (req: HttpRequest, res: HttpResponse): string => {
    const remoteIp = normalizeIp(ab2str(res.getRemoteAddressAsText())) ?? 'unknown'
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
