import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { rememberPostSignInTarget, takePostSignInTarget } from '../post-sign-in-target'

// feat-154: an OAuth sign-in leaves the application for the provider and comes back to "/", so
// the page the visitor was going to is kept in sessionStorage for the trip.
describe('post-sign-in target', () => {
    beforeEach(() => {
        sessionStorage.clear()
        vi.useFakeTimers({ now: 1_000_000 })
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('gives back the remembered path once', () => {
        rememberPostSignInTarget('/support?tab=1')

        expect(takePostSignInTarget()).toBe('/support?tab=1')
        expect(takePostSignInTarget()).toBeNull()
    })

    it.each([undefined, null, 7, '', 'support', 'https://evil.example/', '//evil.example'])(
        'remembers nothing for a value that is not a path inside the application: %s',
        (value) => {
            rememberPostSignInTarget('/support')
            rememberPostSignInTarget(value)

            expect(takePostSignInTarget()).toBeNull()
        },
    )

    it('does not trust what is in the storage: it is checked again when taken', () => {
        sessionStorage.setItem(
            'post-sign-in-target',
            JSON.stringify({ target: 'https://evil.example/', at: Date.now() }),
        )

        expect(takePostSignInTarget()).toBeNull()
    })

    it('forgets a target after ten minutes: the sign-in it was for never finished', () => {
        rememberPostSignInTarget('/support')
        vi.setSystemTime(1_000_000 + 10 * 60_000 + 1)

        expect(takePostSignInTarget()).toBeNull()
    })

    it('reads garbage in the storage as nothing', () => {
        sessionStorage.setItem('post-sign-in-target', '{not json')

        expect(takePostSignInTarget()).toBeNull()
    })
})
