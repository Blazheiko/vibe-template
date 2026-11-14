import { describe, expect, it } from 'vitest'

import { normalizeRoutePath } from '@/utils/route-path'

// feat-211: one form for every spelling of a path the router treats as the same page.
describe('normalizeRoutePath', () => {
    it.each([
        ['/reset-password', '/reset-password'],
        ['/reset-password/', '/reset-password'],
        ['/reset-password///', '/reset-password'],
        ['/Reset-Password', '/reset-password'],
        ['/RESET-PASSWORD/', '/reset-password'],
        ['/reset%2Dpassword', '/reset-password'],
        ['/OAuth/Link/Confirm/', '/oauth/link/confirm'],
        ['/', '/'],
        ['', '/'],
        ['//', '/'],
    ])('%j is %j', (pathname, normalized) => {
        expect(normalizeRoutePath(pathname)).toBe(normalized)
    })

    it('leaves a path with broken percent-encoding as it is, lowercased', () => {
        expect(normalizeRoutePath('/Reset%ZZ')).toBe('/reset%zz')
    })
})
