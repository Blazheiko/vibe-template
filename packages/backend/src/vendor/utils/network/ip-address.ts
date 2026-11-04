import { isIP } from 'node:net'

// Parsing and comparing client addresses, shared by get-ip.ts (who the client is) and the rate
// limiters (which budget the client spends).

export function normalizeIp(value: string): string | null {
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

export function parseIp(ip: string): ParsedIp | null {
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

export function isIpInCidr(ip: string, cidr: string): boolean {
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

const IPV6_LIMIT_PREFIX_BITS = 64n

/**
 * The key a client's per-IP budget is counted under (feat-110). An IPv4 address (an IPv4-mapped
 * IPv6 one included) is itself. An IPv6 address is its /64 network, canonical (`2001:db8:1:2::/64`
 * for any spelling of any address in it): one ordinary allocation is one client, not 2^64 fresh
 * budgets. Anything else is `unknown`. Logs and stored data keep the full address; only budgets
 * use this key.
 */
export function rateLimitKeyForIp(ip: string | null | undefined): string {
    if (ip === null || ip === undefined) return 'unknown'
    const parsed = parseIp(ip)
    if (parsed === null) return 'unknown'
    if (parsed.family === 4) return normalizeIp(ip) ?? 'unknown'

    const network = parsed.value >> (128n - IPV6_LIMIT_PREFIX_BITS)
    const groups: string[] = []
    for (let shift = 48n; shift >= 0n; shift -= 16n) {
        groups.push(((network >> shift) & 0xffffn).toString(16))
    }
    return `${groups.join(':')}::/64`
}
