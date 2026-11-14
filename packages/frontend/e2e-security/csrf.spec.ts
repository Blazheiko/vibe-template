import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import { ORIGIN, USER_1, USER_2 } from './fixtures'

/**
 * The SPA against the real backend with CSRF_ENFORCE=true, CSRF_STRICT_ORIGIN=true
 * and CSRF_ALLOWED_ORIGINS set. "Another tab" is `page.request`: it shares the
 * browser context's cookie jar, so what it does to the session is what the page sees.
 */

interface Account {
    email: string
    password: string
}

const loginInUi = async (page: Page, account: Account): Promise<void> => {
    await page.goto('/login')
    await page.locator('#login-identifier').fill(account.email)
    await page.locator('#login-password').fill(account.password)
    await page
        .locator('button.auth-button', { has: page.locator('span', { hasText: 'Sign In' }) })
        .click()
    await expect(page.getByText(account.email)).toBeVisible()
}

const logoutInUi = async (page: Page): Promise<void> => {
    await page.locator('.menu-button').click()
    await page.locator('.menu-item.logout-item').click()
}

/** What another tab of the same browser does: same cookies, its own CSRF token. */
const otherTab = (request: APIRequestContext) => ({
    async token(): Promise<string> {
        const response = await request.get('/api/main/init')
        const body = (await response.json()) as { csrfToken: string }
        return body.csrfToken
    },
    async post(path: string, data: Record<string, unknown>, origin = ORIGIN) {
        const token = await this.token()
        return request.post(path, {
            data,
            headers: { origin, 'x-csrf-token': token },
        })
    },
    async login(account: Account) {
        const response = await this.post('/api/auth/login', {
            identifier: account.email,
            password: account.password,
        })
        expect(response.status()).toBe(200)
    },
    async logout() {
        expect((await this.post('/api/auth/logout', {})).status()).toBe(200)
    },
    async whoAmI(): Promise<string | null> {
        const response = await request.get('/api/main/init')
        if (response.status() === 401) return null
        const body = (await response.json()) as { user: { email: string } }
        return body.user.email
    },
})

/** Unsafe requests the page itself sent to `path`. */
const recordMutations = (page: Page, path: string): string[] => {
    const sent: string[] = []
    page.on('request', (request) => {
        if (request.method() !== 'GET' && new URL(request.url()).pathname === path) {
            sent.push(request.headers()['x-csrf-token'] ?? '')
        }
    })
    return sent
}

test('cold login without a cookie: init 401 → login with its token', async ({ page, context }) => {
    await context.clearCookies()
    const statuses: number[] = []
    page.on('response', (response) => {
        const path = new URL(response.url()).pathname
        if (path === '/api/main/init' || path === '/api/auth/login')
            statuses.push(response.status())
    })

    await loginInUi(page, USER_1)

    expect(statuses[0]).toBe(401) // anonymous bootstrap
    expect(statuses).toContain(200) // login passed csrf_guard
})

test('logout then login again in the same tab', async ({ page }) => {
    await loginInUi(page, USER_1)
    await logoutInUi(page)
    await expect(page).toHaveURL(/\/login/)

    await loginInUi(page, USER_1)
})

test('stale token on a live session: one retry, the action runs once', async ({ page }) => {
    await loginInUi(page, USER_1)
    // Another tab signs in as the same user: new session and token for U1, the
    // page's token is stale.
    await otherTab(page.request).login(USER_1)
    const logouts = recordMutations(page, '/api/auth/logout')

    await logoutInUi(page)

    await expect(page).toHaveURL(/\/login/)
    expect(logouts).toHaveLength(2) // 403 token_mismatch, then the retry
    expect(logouts[0]).not.toBe(logouts[1])
    expect(await otherTab(page.request).whoAmI()).toBeNull() // logged out exactly once
})

test('session lost in another tab: no retry, back to login', async ({ page }) => {
    await loginInUi(page, USER_1)
    await otherTab(page.request).logout()
    const logouts = recordMutations(page, '/api/auth/logout')

    await logoutInUi(page)

    await expect(page).toHaveURL(/\/login/)
    expect(logouts).toHaveLength(1)
})

test('account switched in another tab: no retry, reload as the new user, no data of the old one', async ({
    page,
}) => {
    await loginInUi(page, USER_1)
    await otherTab(page.request).login(USER_2)
    const logouts = recordMutations(page, '/api/auth/logout')

    await logoutInUi(page)

    // The page reloads for USER_2; the logout meant for USER_1 never reaches USER_2.
    await expect(page.getByText(USER_2.email)).toBeVisible()
    await expect(page.getByText(USER_1.email)).toHaveCount(0)
    expect(logouts).toHaveLength(1)
    expect(await otherTab(page.request).whoAmI()).toBe(USER_2.email)
})

test('rejected mutations have no side effect', async ({ page }) => {
    await loginInUi(page, USER_1)
    const tab = otherTab(page.request)

    const foreign = await tab.post('/api/auth/logout', {}, 'https://evil.example')
    expect(foreign.status()).toBe(403)
    expect(await foreign.json()).toMatchObject({ code: 'csrf_invalid', reason: 'origin_mismatch' })

    const crossSite = await page.request.post('/api/auth/logout', {
        headers: {
            origin: ORIGIN,
            'sec-fetch-site': 'cross-site',
            'x-csrf-token': await tab.token(),
        },
    })
    expect(crossSite.status()).toBe(403)
    expect(await crossSite.json()).toMatchObject({ reason: 'fetch_site_cross_site' })

    const noToken = await page.request.post('/api/auth/logout', { headers: { origin: ORIGIN } })
    expect(noToken.status()).toBe(403)
    expect(await noToken.json()).toMatchObject({ reason: 'token_mismatch' })

    const noOrigin = await page.request.post('/api/auth/logout', {
        headers: { 'x-csrf-token': await tab.token() },
    })
    expect(noOrigin.status()).toBe(403)

    // Still signed in: none of the rejected logouts ran.
    expect(await tab.whoAmI()).toBe(USER_1.email)
})
