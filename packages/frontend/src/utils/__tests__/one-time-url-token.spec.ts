import { beforeEach, describe, expect, it } from 'vitest'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import {
    __resetUrlTokensForTests,
    clearUrlToken,
    isTokenRoute,
    readUrlToken,
    redirectWithoutUrlToken,
    stashUrlToken,
    stripUrlTokenFromLocation,
} from '@/utils/one-time-url-token'

// feat-205 (security review 2026-11-12, L-17): the one-time token of a mailed link is taken
// out of the address before anything reads it, and kept for the page that needs it.
const visit = (url: string): void => {
    window.history.replaceState({ kept: true }, '', url)
}

beforeEach(() => {
    __resetUrlTokensForTests()
    window.sessionStorage.clear()
    visit('/')
})

describe('stripUrlTokenFromLocation', () => {
    it.each(['/reset-password', '/verify-email', '/oauth/link/confirm'])(
        'takes the token of %s out of the address and keeps it for the page',
        (path) => {
            visit(`${path}?token=canary-1`)

            expect(stripUrlTokenFromLocation()).toBe(true)

            expect(window.location.pathname).toBe(path)
            expect(window.location.search).toBe('')
            expect(window.location.href).not.toContain('canary-1')
            expect(readUrlToken(path)).toBe('canary-1')
        },
    )

    // feat-211: every spelling the router opens the page with. Compared by the exact path,
    // these kept their token in the address.
    it.each([
        ['/reset-password/', '/reset-password'],
        ['/Reset-Password', '/reset-password'],
        ['/RESET-PASSWORD/', '/reset-password'],
        ['/reset%2Dpassword', '/reset-password'],
        ['/reset-password//', '/reset-password'],
        ['/Verify-Email/', '/verify-email'],
        ['/OAuth/Link/Confirm/', '/oauth/link/confirm'],
        ['/App/Reset-Password/', '/reset-password'],
    ])('takes the token out of %s too', (spelling, routePath) => {
        visit(`${spelling}?token=canary-v&lang=uk`)

        expect(stripUrlTokenFromLocation()).toBe(true)

        expect(window.location.href).not.toContain('canary-v')
        expect(window.location.search).toBe('?lang=uk')
        // The page reads it by its own path, whatever the spelling in the address.
        expect(readUrlToken(routePath)).toBe('canary-v')
        expect(readUrlToken(spelling)).toBe('canary-v')
    })

    it('still leaves a page whose name only resembles a token page alone', () => {
        visit('/reset-password-help?token=canary-n')

        expect(stripUrlTokenFromLocation()).toBe(false)
        expect(window.location.search).toBe('?token=canary-n')
    })

    it('keeps the other query parameters, the hash and the history state', () => {
        visit('/reset-password?lang=uk&token=canary-2&ref=mail#form')

        stripUrlTokenFromLocation()

        expect(window.location.search).toBe('?lang=uk&ref=mail')
        expect(window.location.hash).toBe('#form')
        expect(window.history.state).toEqual({ kept: true })
        expect(readUrlToken('/reset-password')).toBe('canary-2')
    })

    it('works when the application is served under a base path', () => {
        visit('/app/reset-password?token=canary-3')

        expect(stripUrlTokenFromLocation()).toBe(true)

        expect(window.location.pathname).toBe('/app/reset-password')
        expect(window.location.search).toBe('')
        expect(readUrlToken('/reset-password')).toBe('canary-3')
    })

    it('leaves the address of any other page alone, token or not', () => {
        visit('/account?token=not-ours')

        expect(stripUrlTokenFromLocation()).toBe(false)

        expect(window.location.search).toBe('?token=not-ours')
        expect(readUrlToken('/account')).toBe('')
    })

    it('does nothing on a token page opened without a token', () => {
        visit('/verify-email?lang=uk')

        expect(stripUrlTokenFromLocation()).toBe(false)
        expect(window.location.search).toBe('?lang=uk')
        expect(readUrlToken('/verify-email')).toBe('')
    })

    it('takes an empty token out too and keeps nothing', () => {
        visit('/reset-password?token=')

        expect(stripUrlTokenFromLocation()).toBe(true)
        expect(window.location.search).toBe('')
        expect(readUrlToken('/reset-password')).toBe('')
    })
})

describe('the kept token', () => {
    it('survives a reload of the page (a new module instance reads sessionStorage)', () => {
        stashUrlToken('/reset-password', 'canary-4')
        __resetUrlTokensForTests()

        expect(readUrlToken('/reset-password')).toBe('canary-4')
    })

    it('is kept per page', () => {
        stashUrlToken('/reset-password', 'reset-token')
        stashUrlToken('/verify-email', 'verify-token')

        expect(readUrlToken('/reset-password')).toBe('reset-token')
        expect(readUrlToken('/verify-email')).toBe('verify-token')
        expect(readUrlToken('/oauth/link/confirm')).toBe('')
    })

    it('is forgotten once the page has used it, in memory and in sessionStorage', () => {
        stashUrlToken('/reset-password', 'canary-5')

        clearUrlToken('/reset-password')

        expect(readUrlToken('/reset-password')).toBe('')
        __resetUrlTokensForTests()
        expect(readUrlToken('/reset-password')).toBe('')
        expect(JSON.stringify(window.sessionStorage)).not.toContain('canary-5')
    })

    it('is trimmed, and a blank one or one for another page is not kept', () => {
        stashUrlToken('/reset-password', '  canary-6  ')
        stashUrlToken('/verify-email', '   ')
        stashUrlToken('/account', 'not-ours')

        expect(readUrlToken('/reset-password')).toBe('canary-6')
        expect(readUrlToken('/verify-email')).toBe('')
        expect(readUrlToken('/account')).toBe('')
        expect(window.sessionStorage.length).toBe(1)
    })

    it('names the pages a mailed link opens', () => {
        expect(isTokenRoute('/reset-password')).toBe(true)
        expect(isTokenRoute('/account')).toBe(false)
    })
})

// A navigation inside the application that carries a token (not the first page load, which
// main.ts handles before the router exists).
describe('redirectWithoutUrlToken', () => {
    const newRouter = () => {
        const Page = defineComponent({ render: () => null })
        const router = createRouter({
            history: createMemoryHistory(),
            routes: [
                { path: '/', component: Page },
                { path: '/reset-password', component: Page },
                { path: '/account', component: Page },
            ],
        })
        router.beforeEach((to) => redirectWithoutUrlToken(to) as never)
        return router
    }

    // feat-211: the router serves these spellings of the route, so the guard must know them.
    it.each(['/reset-password/', '/Reset-Password', '/RESET-PASSWORD/'])(
        'takes the token out of a navigation to %s',
        async (spelling) => {
            const router = newRouter()
            await router.push('/')

            await router.push(`${spelling}?token=canary-g&lang=uk`)

            expect(router.currentRoute.value.matched).toHaveLength(1)
            expect(router.currentRoute.value.fullPath).not.toContain('canary-g')
            expect(router.currentRoute.value.query).toEqual({ lang: 'uk' })
            expect(readUrlToken(router.currentRoute.value.path)).toBe('canary-g')
        },
    )

    it('keeps the token and goes on to the same page without it', async () => {
        const router = newRouter()
        await router.push('/')

        await router.push('/reset-password?token=canary-7&lang=uk#form')

        expect(router.currentRoute.value.fullPath).toBe('/reset-password?lang=uk#form')
        expect(readUrlToken('/reset-password')).toBe('canary-7')
    })

    it('replaces the history entry: going back does not bring the token back', async () => {
        const router = newRouter()
        await router.push('/')
        await router.push('/reset-password?token=canary-8')
        await router.push('/account')

        router.back()
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(router.currentRoute.value.fullPath).toBe('/reset-password')
    })

    it('leaves a navigation without a token, and a token of another page, alone', async () => {
        const router = newRouter()

        await router.push('/reset-password')
        expect(router.currentRoute.value.fullPath).toBe('/reset-password')
        await router.push('/account?token=not-ours')
        expect(router.currentRoute.value.fullPath).toBe('/account?token=not-ours')

        expect(readUrlToken('/reset-password')).toBe('')
    })

    it('takes an empty token out of the address and keeps what was kept before', async () => {
        stashUrlToken('/reset-password', 'canary-9')
        const router = newRouter()

        await router.push('/reset-password?token=')

        expect(router.currentRoute.value.fullPath).toBe('/reset-password')
        expect(readUrlToken('/reset-password')).toBe('canary-9')
    })
})
