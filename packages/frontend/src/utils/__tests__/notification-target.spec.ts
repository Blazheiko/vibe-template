import { describe, expect, it } from 'vitest'

import { isSameTarget, resolveNotificationTarget } from '../notification-target'

const ORIGIN = 'https://app.example.com'

// The URL of a push notification comes from the push payload. The service worker opens it and
// compares it with the open windows: it must stay inside the application, and "is this window
// already on that page" is a question about the page, not about a substring.
describe('resolveNotificationTarget', () => {
    it.each([
        ['/support', 'https://app.example.com/support'],
        ['/support?tab=chat#last', 'https://app.example.com/support?tab=chat#last'],
        ['https://app.example.com/account', 'https://app.example.com/account'],
        ['support', 'https://app.example.com/support'],
    ])('keeps the same-origin address %s', (raw, expected) => {
        expect(resolveNotificationTarget(raw, ORIGIN)).toBe(expected)
    })

    it.each([
        ['an absolute address on another origin', 'https://evil.example.net/phish'],
        ['a protocol-relative address', '//evil.example.net/phish'],
        ['a backslash-relative address', '/\\evil.example.net/phish'],
        ['a lookalike host', 'https://app.example.com.evil.net/'],
        ['a subdomain', 'https://sub.app.example.com/'],
        ['another port', 'https://app.example.com:8443/'],
        ['another scheme', 'http://app.example.com/'],
        ['a javascript: URL', 'javascript:alert(1)'],
        ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ])('falls back to the start page for %s', (_label, raw) => {
        expect(resolveNotificationTarget(raw, ORIGIN)).toBe('https://app.example.com/')
    })

    it.each([undefined, null, '', '   ', 42, {}, []])(
        'falls back to the start page for %j',
        (raw) => {
            expect(resolveNotificationTarget(raw, ORIGIN)).toBe('https://app.example.com/')
        },
    )
})

describe('isSameTarget', () => {
    const target = 'https://app.example.com/support'

    it('matches a window on the same page, whatever the query or the fragment', () => {
        expect(isSameTarget('https://app.example.com/support', target)).toBe(true)
        expect(isSameTarget('https://app.example.com/support?tab=chat#last', target)).toBe(true)
    })

    // `client.url.includes(url)` took all of these for the page.
    it.each([
        'https://app.example.com/support/archive',
        'https://app.example.com/old-support',
        'https://app.example.com/other?next=https://app.example.com/support',
        'https://evil.example.net/?https://app.example.com/support',
        'https://app.example.com/account',
    ])('does not match %s', (clientUrl) => {
        expect(isSameTarget(clientUrl, target)).toBe(false)
    })

    it('does not match a window on another origin with the same path', () => {
        expect(isSameTarget('https://other.example.net/support', target)).toBe(false)
    })

    it('does not throw on a URL it cannot parse', () => {
        expect(isSameTarget('not a url', target)).toBe(false)
    })
})
