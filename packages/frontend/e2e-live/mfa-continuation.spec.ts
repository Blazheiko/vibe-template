import type { Browser, BrowserContext, Page, Route } from '@playwright/test'

import { API, ORIGIN } from './fixtures'
import type { Account } from './support'
import {
    createVerifiedAccount,
    enrollTotp,
    expect,
    newBrowser,
    nextTotp,
    session,
    test,
} from './support'
import type { MailSink } from './mail-sink'

// feat-257 (docs/plan/mfa-review-fixes-7-plan.md, item 2) against the real backend: the second
// sign-in step is finished after its answer was lost, though the activation deleted the browser's
// previous session. The ticket is bound to a cookie of its own (mfa_bind), which outlives that
// session; csrf_guard and the `account_changed` reload stay. playwright.live-prefix.config.ts runs
// this spec again with another API_PATH_PREFIX: both cookies have Path=/.

interface MfaAccount extends Account {
    secret: string
}

/** A verified account with an authenticator app; nothing is signed in afterwards. */
async function accountWithApp(browser: Browser, sink: MailSink): Promise<MfaAccount> {
    const account = await createVerifiedAccount(browser, sink)
    const { context } = await newBrowser(browser)
    try {
        const tab = session(context.request)
        const signedIn = await tab.post(`${API}/auth/login`, {
            identifier: account.email,
            password: account.password,
        })
        expect(signedIn.status()).toBe(200)
        return { ...account, secret: await enrollTotp(context.request) }
    } finally {
        await context.close()
    }
}

/** The browser's cookies as a request header (what a lost request carried). */
async function cookieHeader(context: BrowserContext): Promise<string> {
    return (await context.cookies(ORIGIN)).map((c) => `${c.name}=${c.value}`).join('; ')
}

/**
 * The next verify request of `page` reaches the server, which signs in, but its answer never
 * reaches the browser: the request is sent outside the browser (its cookies stay as they were),
 * and the browser sees a network failure.
 */
async function loseNextVerifyAnswer(page: Page): Promise<() => number> {
    let status = 0
    let lost = false
    await page.route(`**${API}/auth/mfa/verify`, async (route: Route) => {
        if (lost) return route.fallback()
        lost = true
        const request = route.request()
        const response = await fetch(request.url(), {
            method: 'POST',
            headers: await request.allHeaders(),
            body: request.postData() ?? '',
        })
        status = response.status
        await route.abort('failed')
    })
    return () => status
}

async function passwordStep(page: Page, account: Account): Promise<void> {
    await page.locator('#login-identifier').fill(account.email)
    await page.locator('#login-password').fill(account.password)
    await page
        .locator('button.auth-button', { has: page.locator('span', { hasText: 'Sign In' }) })
        .click()
    await expect(page.getByTestId('mfa-challenge')).toBeVisible()
}

test('an anonymous session kept in Redis (an OAuth start): a lost answer is finished by "Try again"', async ({
    browser,
    sink,
}) => {
    const account = await accountWithApp(browser, sink)
    const { page, context } = await newBrowser(browser)
    try {
        await page.goto('/login')
        await expect(page.locator('#login-identifier')).toBeVisible()
        // The start of an OAuth sign-in writes its state into the anonymous session, which moves
        // to Redis; the provider's page is not opened.
        const started = await page.request.get(`${API}/auth/oauth/google/redirect`, {
            maxRedirects: 0,
        })
        expect(started.status()).toBe(302)
        await passwordStep(page, account)

        const lostStatus = await loseNextVerifyAnswer(page)
        await page.getByTestId('mfa-code').fill(await nextTotp(account.secret))
        await page.getByTestId('mfa-submit').click()
        // The server signed in; the browser saw no answer and keeps the request.
        await expect.poll(lostStatus).toBe(200)
        await expect(page.getByRole('alert')).toBeVisible()

        // "Try again": csrf_guard refuses the deleted session's token, the client reads a new
        // anonymous session, and the same request finishes the sign-in by the ticket's binding.
        await page.getByTestId('mfa-submit').click()
        await expect(page).toHaveURL(/\/account/)
        await expect(page.getByText(account.email)).toBeVisible()
    } finally {
        await context.close()
    }
})

test('a signed-in session of another account: the reloaded OAuth return page finishes the sign-in', async ({
    browser,
    sink,
}) => {
    const other = await createVerifiedAccount(browser, sink)
    const account = await accountWithApp(browser, sink)
    const { page, context } = await newBrowser(browser)
    try {
        const tab = session(context.request)
        // The browser is signed in as another account.
        const signedIn = await tab.post(`${API}/auth/login`, {
            identifier: other.email,
            password: other.password,
        })
        expect(signedIn.status()).toBe(200)
        expect(await tab.whoAmI()).toBe(other.email)
        // A sign-in of this account starts in it: the ticket and its binding cookie land here.
        const opened = await tab.post(`${API}/auth/login`, {
            identifier: account.email,
            password: account.password,
        })
        expect(await opened.json()).toMatchObject({ status: 'mfa_required' })

        // Its verify is confirmed and activated, and the answer is lost: the browser keeps the
        // other account's cookie, whose session the activation deleted.
        const verified = await fetch(`${ORIGIN}${API}/auth/mfa/verify`, {
            method: 'POST',
            headers: {
                cookie: await cookieHeader(context),
                origin: ORIGIN,
                'content-type': 'application/json',
                'x-csrf-token': await tab.token(),
            },
            body: JSON.stringify({ method: 'totp', code: await nextTotp(account.secret) }),
        })
        expect(verified.status).toBe(200)

        // The OAuth return page of the sign-in is loaded again (as after the reload of
        // `account_changed`): the page-load answer of POST /auth/mfa/state says the ticket is
        // finishing, and the form continues it.
        await page.goto('/login?mfa=required&methods=totp,recovery_code')
        await expect(page).toHaveURL(/\/account/)
        await expect(page.getByText(account.email)).toBeVisible()
        expect(await tab.whoAmI()).toBe(account.email)
    } finally {
        await context.close()
    }
})

// feat-258 (docs/plan/mfa-review-fixes-7-plan.md, 8.3): the automatic `account_changed` reload. The
// MFA form shows only on /login, which the app leaves for a signed-in user, so its tab always holds
// an anonymous session's CSRF token; when another tab signs another account in meanwhile, the
// verify is refused by csrf_guard before its proof is looked at: nothing is spent, the ticket stays
// open, and the reloaded tab shows the account the browser is signed in to.
test('another tab signs another account in during the second step: the reload spends nothing', async ({
    browser,
    sink,
}) => {
    const other = await createVerifiedAccount(browser, sink)
    const account = await accountWithApp(browser, sink)
    const { page, context } = await newBrowser(browser)
    try {
        await page.goto('/login')
        await expect(page.locator('#login-identifier')).toBeVisible()
        await passwordStep(page, account)

        // Another tab of the same browser signs the other account in.
        const tab = session(context.request)
        const signedIn = await tab.post(`${API}/auth/login`, {
            identifier: other.email,
            password: other.password,
        })
        expect(signedIn.status()).toBe(200)

        const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame())
        await page.getByTestId('mfa-code').fill(await nextTotp(account.secret))
        await page.getByTestId('mfa-submit').click()
        // account_changed: the page reloads and shows the account the browser is signed in to.
        await reloaded
        await expect(page).toHaveURL(/\/account/)
        await expect(page.getByText(other.email)).toBeVisible()
        expect(await tab.whoAmI()).toBe(other.email)

        // The second step was never looked at: its ticket is still open, nothing captured.
        const state = await tab.post(`${API}/auth/mfa/state`, {})
        expect(await state.json()).toMatchObject({ status: 'mfa_required' })
        expect(await state.json()).not.toHaveProperty('completing')
    } finally {
        await context.close()
    }
})
