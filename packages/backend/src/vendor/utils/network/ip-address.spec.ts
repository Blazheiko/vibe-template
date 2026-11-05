import { describe, expect, it } from 'vitest'

import { isIpInCidr, rateLimitKeyForIp } from './ip-address.js'

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

// feat-121 (M1): a dual-stack uWS listener (listen('::')) reports an IPv4 client as
// 0000:0000:0000:0000:0000:ffff:7f00:0001 (seen on the real server); every IPv4-mapped form is the
// IPv4 address, so each IPv4 client keeps its own key.
describe('IPv4-mapped addresses in every form (feat-121)', () => {
    it.each([
        '0000:0000:0000:0000:0000:ffff:7f00:0001',
        '0:0:0:0:0:ffff:7f00:1',
        '::ffff:7f00:1',
        '::ffff:127.0.0.1',
        '[::FFFF:7F00:1]',
    ])('%s is 127.0.0.1', (ip) => {
        expect(rateLimitKeyForIp(ip)).toBe('127.0.0.1')
    })

    it('two IPv4 clients behind a dual-stack listener keep separate keys', () => {
        expect(rateLimitKeyForIp('0000:0000:0000:0000:0000:ffff:c000:0201')).toBe('192.0.2.1')
        expect(rateLimitKeyForIp('0000:0000:0000:0000:0000:ffff:c000:0202')).toBe('192.0.2.2')
    })

    it('an address next to the mapped range stays IPv6', () => {
        expect(rateLimitKeyForIp('::fffe:7f00:1')).toBe('0:0:0:0::/64')
        expect(rateLimitKeyForIp('64:ff9b::7f00:1')).toBe('64:ff9b:0:0::/64')
    })
})

// feat-130 (fifth review): a CIDR written in IPv4-mapped form is the IPv4 network with the
// prefix less 96; it used to match nothing once mapped addresses became IPv4 (feat-121).
describe('isIpInCidr with an IPv4-mapped CIDR (feat-130)', () => {
    it.each([
        ['10.0.0.1', '::ffff:a00:0/104', true],
        ['0000:0000:0000:0000:0000:ffff:0a00:0001', '::ffff:a00:0/104', true],
        ['10.0.0.1', '::ffff:10.0.0.0/104', true],
        ['11.0.0.1', '::ffff:10.0.0.0/104', false],
        ['10.0.0.1', '::ffff:10.0.0.1/128', true],
        ['10.0.0.1', '::ffff:0:0/96', true],
        // Shorter than /96 reaches past the mapped range: not an IPv4 network.
        ['10.0.0.1', '::ffff:0:0/80', false],
    ])('%s in %s → %s', (ip, cidr, expected) => {
        expect(isIpInCidr(ip, cidr)).toBe(expected)
    })
})
