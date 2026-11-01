import { describe, expect, it } from 'vitest'

import { safeRedirectTarget } from '../safe-redirect'

// `?redirect=` says where to go after sign-in. It is set by whoever builds the link, so it may
// only point inside the application.
describe('safeRedirectTarget', () => {
    it.each(['/account', '/support?tab=chat', '/a/b#c', '/'])(
        'accepts the in-app path %s',
        (value) => {
            expect(safeRedirectTarget(value)).toBe(value)
        },
    )

    it.each([
        '//evil.example.net',
        '//evil.example.net/path',
        '/\\evil.example.net',
        '\\\\evil.example.net',
        'https://evil.example.net',
        'http://localhost:5173/account',
        'javascript:alert(1)',
        'account',
        ' /account',
        '/account\nSet-Cookie: x=1',
        '/ac\tcount',
    ])('refuses %j', (value) => {
        expect(safeRedirectTarget(value)).toBeNull()
    })

    it.each([undefined, null, '', 42, {}, ['/account'], ['/a', '/b']])('refuses %j', (value) => {
        expect(safeRedirectTarget(value)).toBeNull()
    })
})
