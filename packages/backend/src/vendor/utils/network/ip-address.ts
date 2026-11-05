import { isIP } from 'node:net'

// Parsing and comparing client addresses, shared by get-ip.ts (who the client is) and the rate
// limiters (which budget the client spends).

/**
 * The canonical text of a client address, or null when `value` is not one. It runs on every entry
 * of a forwarded chain, i.e. on text a client wrote, so it never throws: a throw here stopped the
 * process (getIP runs synchronously in the uWS handlers, outside any try).
 *
 * An IPv6 zone id (`fe80::1%eth0`, `::%1`) names an interface of the machine that wrote it, not a
 * part of the address: it is dropped. Before, `::%1` made the IPv4-mapped check throw
 * (`NaN cannot be converted to a BigInt`) and `::ffff:1.2.3.4%x` read as 1.2.3.0.
 */
export function normalizeIp(value: string): string | null {
    const trimmed = value.trim()
    if (trimmed === '') {
        return null
    }

    const withoutBrackets =
        trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
    const lower = withoutBrackets.toLowerCase()
    const zoneAt = lower.indexOf('%')
    const address = zoneAt === -1 ? lower : lower.slice(0, zoneAt)
    const kind = isIP(address)
    if (kind === 0) return null
    // A zone id belongs to IPv6 only (`1.2.3.4%x` is not an address) and is never empty.
    if (zoneAt !== -1 && (kind !== 6 || zoneAt === lower.length - 1)) return null
    if (kind === 4) return address
    try {
        return mappedIPv4(address) ?? address
    } catch {
        return null
    }
}

const MAPPED_V4_PREFIX = 0xffffn << 32n

/**
 * The IPv4 address of an IPv4-mapped IPv6 address (::ffff:0:0/96), whatever form it is written in:
 * `::ffff:127.0.0.1`, `::ffff:7f00:1` or `0:0:0:0:0:ffff:7f00:1`. A dual-stack listener reports
 * IPv4 clients in the hex forms (feat-121, M1); without this they all fell into one /64 key.
 */
function mappedIPv4(ip: string): string | null {
    const value = parseIPv6ToBigInt(ip)
    if (value >> 32n !== MAPPED_V4_PREFIX >> 32n) return null
    const v4 = Number(value & 0xffffffffn)
    return [v4 >>> 24, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff].join('.')
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

interface ParsedCidr {
    network: ParsedIp
    /** Bits of `network.value` that must match. */
    prefix: number
}

// feat-132 (P2): the prefix is 1-3 decimal digits and nothing else. It used to be read with
// Number(), for which '', ' 0' and '.0' are 0: a TRUSTED_PROXY_CIDRS entry with a typo was /0
// and trusted every address.
const PREFIX_RE = /^\d{1,3}$/

/** A CIDR (`10.0.0.0/8`, `2001:db8::/32`, `::ffff:a00:0/104`), or null when it is not one. */
function parseCidr(cidr: string): ParsedCidr | null {
    const parts = cidr.split('/')
    if (parts.length !== 2) return null
    const [networkRaw = '', prefixRaw = ''] = parts
    if (!PREFIX_RE.test(prefixRaw)) return null
    const network = parseIp(networkRaw)
    if (network === null) return null

    const writtenPrefix = Number(prefixRaw)
    // feat-130: an IPv4-mapped network (`::ffff:a00:0/104`) parses as IPv4 (feat-121), and its
    // prefix counts the 96 bits of the mapping too. Shorter than /96 is not an IPv4 network.
    const mapped = network.family === 4 && networkRaw.includes(':')
    const prefix = mapped ? writtenPrefix - 96 : writtenPrefix
    const maxBits = network.family === 4 ? 32 : 128
    if (prefix < 0 || prefix > maxBits) return null
    return { network, prefix }
}

/**
 * Whether a TRUSTED_PROXY_CIDRS entry is an address or a CIDR (feat-132). An entry that is
 * neither stops the start: matching nothing would silently trust no proxy, and the old lenient
 * reading trusted every client.
 */
export function isValidCidrEntry(entry: string): boolean {
    return entry.includes('/') ? parseCidr(entry) !== null : normalizeIp(entry) !== null
}

export function isIpInCidr(ip: string, cidr: string): boolean {
    if (!cidr.includes('/')) {
        const normalizedIp = normalizeIp(ip)
        return normalizedIp !== null && normalizedIp === normalizeIp(cidr)
    }

    const parsedCidr = parseCidr(cidr)
    const parsedIp = parseIp(ip)
    if (parsedCidr === null || parsedIp === null) return false
    const { network, prefix } = parsedCidr
    if (parsedIp.family !== network.family) return false

    const maxBits = parsedIp.family === 4 ? 32 : 128
    const shift = BigInt(maxBits - prefix)
    return parsedIp.value >> shift === network.value >> shift
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
