import { describe, expect, it } from 'vitest'

import { rateLimitKeyForIp } from './ip-address.js'

describe('rateLimitKeyForIp (feat-110)', () => {
    it('groups every spelling of every address of one IPv6 /64 into one key', () => {
        const keys = [
            '2001:db8:1:2::a',
            '2001:DB8:1:2:0:0:0:b',
            '2001:0db8:0001:0002:ffff:ffff:ffff:ffff',
            '[2001:db8:1:2::1]',
            '2001:db8:1:2:0:0:192.0.2.1',
        ].map((ip) => rateLimitKeyForIp(ip))

        expect(new Set(keys)).toEqual(new Set(['2001:db8:1:2::/64']))
    })

    it('gives another /64 another key', () => {
        expect(rateLimitKeyForIp('2001:db8:1:3::a')).toBe('2001:db8:1:3::/64')
        expect(rateLimitKeyForIp('::1')).toBe('0:0:0:0::/64')
    })

    it('keeps IPv4 and IPv4-mapped IPv6 as the IPv4 address', () => {
        expect(rateLimitKeyForIp('203.0.113.7')).toBe('203.0.113.7')
        expect(rateLimitKeyForIp('::ffff:203.0.113.7')).toBe('203.0.113.7')
        expect(rateLimitKeyForIp('::FFFF:203.0.113.7')).toBe('203.0.113.7')
    })

    it.each([null, undefined, '', 'unknown', 'not-an-ip', '999.1.1.1'])(
        'answers unknown for %s',
        (value) => {
            expect(rateLimitKeyForIp(value)).toBe('unknown')
        },
    )
})
