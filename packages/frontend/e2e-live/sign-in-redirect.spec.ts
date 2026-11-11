import { createVerifiedAccount, expect, newBrowser, test } from './support'

// feat-154 (review 2026-11-10, M10): the router guard sends an anonymous visitor of a protected
// page to /login?redirect=<that page>. After the sign-in the visitor used to land on /account
// whatever the redirect said (AC-AUTH-001).

async function signInThroughTheForm(
    page: Awaited<ReturnType<typeof newBrowser>>['page'],
    account: { email: string; password: string },
): Promise<void> {
    await page.locator('#login-identifier').fill(account.email)
    await page.locator('#login-password').fill(account.password)
    const signedIn = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === '/api/auth/login' &&
            response.request().method() === 'POST',
    )
    await page
        .locator('button.auth-button', { has: page.locator('span', { hasText: 'Sign In' }) })
        .click()
    expect((await signedIn).status()).toBe(200)
}

test('after a sign-in the visitor is on the page they were going to', async ({ browser, sink }) => {
    const account = await createVerifiedAccount(browser, sink)
    const { context, page } = await newBrowser(browser)

    await page.goto('/support')
    // The guard's redirect, whatever way the router spells the slash in the query.
    await page.waitForURL(/\/login\?redirect=(%2F|\/)support$/)

    await signInThroughTheForm(page, account)

    // The path itself: "/login?redirect=/support" also ends with "/support".
    await page.waitForURL((url) => url.pathname === '/support')
    // Still there once the app has read the session and opened the WebSocket.
    await expect(page.getByText('How can we help?')).toBeVisible()
    await page.waitForTimeout(1500)
    expect(new URL(page.url()).pathname).toBe('/support')

    await context.close()
})

test('a redirect that points outside the application is ignored', async ({ browser, sink }) => {
    const account = await createVerifiedAccount(browser, sink)
    const { context, page } = await newBrowser(browser)

    await page.goto(`/login?redirect=${encodeURIComponent('//evil.example/steal')}`)
    await signInThroughTheForm(page, account)

    await page.waitForURL((url) => url.pathname === '/account')
    await expect(page.getByText(account.email)).toBeVisible()

    await context.close()
})

test('without a redirect the sign-in ends on the account page, as before', async ({
    browser,
    sink,
}) => {
    const account = await createVerifiedAccount(browser, sink)
    const { context, page } = await newBrowser(browser)

    await page.goto('/login')
    await signInThroughTheForm(page, account)

    await page.waitForURL((url) => url.pathname === '/account')
    await expect(page.getByText(account.email)).toBeVisible()

    await context.close()
})
