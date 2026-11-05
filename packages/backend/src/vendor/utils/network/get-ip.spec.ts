import { afterEach, describe, expect, it, vi } from 'vitest'

interface MockRequest {
    getHeader: (name: string) => string
}

interface MockResponse {
    getRemoteAddressAsText: () => ArrayBuffer
}

function makeReq(headers: Record<string, string>): MockRequest {
    return {
        getHeader(name: string): string {
            return headers[name.toLowerCase()] ?? ''
        },
    }
}

function makeRes(ip: string): MockResponse {
    return {
        getRemoteAddressAsText(): ArrayBuffer {
            return Uint8Array.from(Buffer.from(ip)).buffer
        },
    }
}

afterEach(() => {
    vi.resetModules()
    delete process.env['TRUST_PROXY']
    delete process.env['TRUSTED_PROXY_CIDRS']
    delete process.env['TRUST_UNIX_SOCKET_PROXY']
    delete process.env['APP_UNIX_PATH']
})

describe('get-ip trust proxy handling', () => {
    it('ignores spoofed forwarded headers when trust proxy is disabled', async () => {
        process.env['TRUST_PROXY'] = 'false'
        const { default: getIp } = await import('./get-ip.js')

        const ip = getIp(
            makeReq({
                'x-forwarded-for': '1.2.3.4',
                'x-real-ip': '5.6.7.8',
            }) as never,
            makeRes('10.0.0.10') as never,
        )

        expect(ip).toBe('10.0.0.10')
    })

    it('uses the nearest untrusted client IP from an X-Forwarded-For chain when remote proxy is trusted', async () => {
        process.env['TRUST_PROXY'] = 'true'
        process.env['TRUSTED_PROXY_CIDRS'] = '10.0.0.0/8, 127.0.0.1/32'
        const { default: getIp } = await import('./get-ip.js')

        const ip = getIp(
            makeReq({ 'x-forwarded-for': '203.0.113.10, 10.1.2.3' }) as never,
            makeRes('10.9.8.7') as never,
        )

        expect(ip).toBe('203.0.113.10')
    })

    it('ignores forwarded chain when the direct peer is not trusted even if TRUST_PROXY=true', async () => {
        process.env['TRUST_PROXY'] = 'true'
        process.env['TRUSTED_PROXY_CIDRS'] = '10.0.0.0/8'
        const { default: getIp } = await import('./get-ip.js')

        const ip = getIp(
            makeReq({ 'x-forwarded-for': '203.0.113.10' }) as never,
            makeRes('198.51.100.55') as never,
        )

        expect(ip).toBe('198.51.100.55')
    })

    it('falls back to x-real-ip only when the direct peer is trusted and x-forwarded-for is absent', async () => {
        process.env['TRUST_PROXY'] = 'true'
        process.env['TRUSTED_PROXY_CIDRS'] = '10.0.0.0/8'
        const { default: getIp } = await import('./get-ip.js')

        const ip = getIp(
            makeReq({ 'x-real-ip': '203.0.113.20' }) as never,
            makeRes('10.2.3.4') as never,
        )

        expect(ip).toBe('203.0.113.20')
    })

    it('matches exact IP and CIDR rules via helper normalization', async () => {
        process.env['TRUST_PROXY'] = 'true'
        process.env['TRUSTED_PROXY_CIDRS'] = '::1/128, 192.168.0.0/16'
        const { __testables__ } = await import('./get-ip.js')

        expect(__testables__.normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1')
        expect(__testables__.isIpInCidr('192.168.1.25', '192.168.0.0/16')).toBe(true)
        expect(__testables__.isIpInCidr('192.169.1.25', '192.168.0.0/16')).toBe(false)
        expect(__testables__.isIpInCidr('::1', '::1/128')).toBe(true)
    })
})

// feat-110 (R07): on a unix socket uWS reports no remote address.
describe('get-ip behind a proxy on a unix socket', () => {
    const unix = async (env: Record<string, string>) => {
        Object.assign(process.env, env)
        const { default: getIp } = await import('./get-ip.js')
        return (headers: Record<string, string>) =>
            getIp(makeReq(headers) as never, makeRes('') as never)
    }

    it('reads the client from X-Forwarded-For with the explicit flag', async () => {
        const getIp = await unix({
            APP_UNIX_PATH: '/tmp/app.sock',
            TRUST_UNIX_SOCKET_PROXY: 'true',
        })

        expect(getIp({ 'x-forwarded-for': '198.51.100.9, 203.0.113.7' })).toBe('203.0.113.7')
    })

    it('a spoofed left entry does not change the result', async () => {
        const getIp = await unix({
            APP_UNIX_PATH: '/tmp/app.sock',
            TRUST_UNIX_SOCKET_PROXY: 'true',
        })

        expect(getIp({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' })).toBe('203.0.113.7')
    })

    it('skips the trusted proxies of the chain, right to left', async () => {
        const getIp = await unix({
            APP_UNIX_PATH: '/tmp/app.sock',
            TRUST_UNIX_SOCKET_PROXY: 'true',
            TRUST_PROXY: 'true',
            TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
        })

        expect(getIp({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7, 10.0.0.2' })).toBe('203.0.113.7')
    })

    it('falls back to X-Real-IP, then unknown', async () => {
        const getIp = await unix({
            APP_UNIX_PATH: '/tmp/app.sock',
            TRUST_UNIX_SOCKET_PROXY: 'true',
        })

        expect(getIp({ 'x-real-ip': '203.0.113.8' })).toBe('203.0.113.8')
        expect(getIp({})).toBe('unknown')
    })

    it('without the flag the headers are ignored', async () => {
        const getIp = await unix({ APP_UNIX_PATH: '/tmp/app.sock' })

        expect(getIp({ 'x-forwarded-for': '203.0.113.7' })).toBe('unknown')
    })

    it('an empty address on a TCP listener proves nothing, even with the flag', async () => {
        const getIp = await unix({ TRUST_UNIX_SOCKET_PROXY: 'true' })

        expect(getIp({ 'x-forwarded-for': '203.0.113.7' })).toBe('unknown')
    })

    it('keeps the full IPv6 address for logs', async () => {
        const getIp = await unix({
            APP_UNIX_PATH: '/tmp/app.sock',
            TRUST_UNIX_SOCKET_PROXY: 'true',
        })

        expect(getIp({ 'x-forwarded-for': '2001:db8:1:2::a' })).toBe('2001:db8:1:2::a')
    })
})

// feat-122 (L7): a proxy that appends ip:port, and an entry that cannot be read.
describe('X-Forwarded-For entries (feat-122)', () => {
    const tcp = async () => {
        process.env['TRUST_PROXY'] = 'true'
        process.env['TRUSTED_PROXY_CIDRS'] = '10.0.0.0/8'
        const { default: getIp } = await import('./get-ip.js')
        return (headers: Record<string, string>) =>
            getIp(makeReq(headers) as never, makeRes('10.0.0.1') as never)
    }

    it.each([
        ['IPv4 with a port', '1.2.3.4, 203.0.113.7:51234', '203.0.113.7'],
        ['IPv6 in brackets with a port', '1.2.3.4, [2001:db8::7]:443', '2001:db8::7'],
    ])('reads %s as the address: the real hop is not lost', async (_label, xff, client) => {
        const getIp = await tcp()
        expect(getIp({ 'x-forwarded-for': xff })).toBe(client)
    })

    it('stops at an entry it cannot read instead of letting a forged left entry win', async () => {
        const getIp = await tcp()
        // Before: "garbage" was dropped and the forged 1.2.3.4 became the client.
        expect(getIp({ 'x-forwarded-for': '1.2.3.4, garbage' })).toBe('10.0.0.1')
        expect(getIp({ 'x-forwarded-for': '1.2.3.4, garbage', 'x-real-ip': '203.0.113.9' })).toBe(
            '203.0.113.9',
        )
    })

    it('an unreadable entry left of the client does not matter', async () => {
        const getIp = await tcp()
        expect(getIp({ 'x-forwarded-for': 'garbage, 203.0.113.7, 10.0.0.2' })).toBe('203.0.113.7')
    })
})

// feat-122 (L8): on the unix socket the explicit flag is the switch, and the CIDRs name the
// proxies in front of the socket's proxy, whatever TRUST_PROXY says.
describe('TRUSTED_PROXY_CIDRS on the unix socket (feat-122)', () => {
    it('skips a trusted CDN hop with TRUST_PROXY=false too', async () => {
        Object.assign(process.env, {
            APP_UNIX_PATH: '/tmp/app.sock',
            TRUST_UNIX_SOCKET_PROXY: 'true',
            TRUST_PROXY: 'false',
            TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
        })
        const { default: getIp } = await import('./get-ip.js')

        expect(
            getIp(
                makeReq({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7, 10.0.0.2' }) as never,
                makeRes('') as never,
            ),
        ).toBe('203.0.113.7')
    })
})
