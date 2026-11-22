import type { Browser, Page } from '@playwright/test'

import { createVerifiedAccount, expect, newBrowser, test } from './support'
import type { Account } from './support'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р6, Р8, Р15; tasks P5) against the real backend, with
// a Chrome virtual authenticator (CDP) in each browser: a passkey added on the account page, a
// sign-in with the passkey alone, the passkey as the second step after the password, and the
// recovery that replaces a lost passkey (the last recovery code, a new passkey, the lost one
// removed, new codes, finish, an ordinary sign-in).

/**
 * A platform authenticator with user verification. With the user present it answers at once,
 * the autofill of the sign-in field included (conditional UI); `present(false)` makes it wait, so
 * a page can be used with the password while a conditional request is pending.
 */
async function withAuthenticator(page: Page): Promise<{ present: (on: boolean) => Promise<void> }> {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
        },
    })
    return {
        present: async (on) => {
            await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
                authenticatorId,
                enabled: on,
            })
        },
    }
}

async function signInPassword(page: Page, account: Account): Promise<void> {
    await page.goto('/login')
    await page.locator('#login-identifier').fill(account.email)
    await page.locator('#login-password').fill(account.password)
    const answered = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === '/api/auth/login' &&
            response.request().method() === 'POST',
    )
    await page
        .locator('button.auth-button', { has: page.locator('span', { hasText: 'Sign In' }) })
        .click()
    expect((await answered).status()).toBe(200)
}

const security = (page: Page) => page.getByTestId('mfa-settings')

/** Signs in with the password and adds a passkey; answers the recovery codes shown once. */
async function addPasskey(page: Page, account: Account): Promise<string[]> {
    await signInPassword(page, account)
    await page.goto('/account')
    await page.getByTestId('passkey-add').click()
    await expect(page.getByTestId('passkey-message')).toHaveText('The passkey was added.')
    await expect(page.getByTestId('passkey-item')).toHaveCount(1)
    const codes = await security(page).getByTestId('mfa-codes').locator('li').allTextContents()
    return codes.map((code) => code.trim())
}

async function enrolled(browser: Browser, sink: Parameters<typeof createVerifiedAccount>[1]) {
    const account = await createVerifiedAccount(browser, sink)
    const first = await newBrowser(browser)
    const authenticator = await withAuthenticator(first.page)
    const codes = await addPasskey(first.page, account)
    expect(codes).toHaveLength(10)
    return { account, first, codes, authenticator }
}

test('a passkey added on the account page signs in alone, from the autofill and by the button', async ({
    browser,
    sink,
}) => {
    const { account, first, authenticator } = await enrolled(browser, sink)
    try {
        // Signed out, the same browser (the same authenticator): the sign-in field's autofill
        // offers the passkey (conditional UI); the user present picks it.
        await first.context.clearCookies()
        await first.page.goto('/login')
        await first.page.locator('#login-identifier').click()
        await expect(first.page).toHaveURL(/\/account/)
        await expect(first.page.getByText(account.email)).toBeVisible()

        // The button: the autofill request waits (no user), the button replaces it.
        await first.context.clearCookies()
        await authenticator.present(false)
        await first.page.goto('/login')
        // The button starts its ceremony (it would replace a pending autofill one), and the user
        // confirms on the authenticator after that.
        await first.page.getByTestId('passkey-sign-in').click()
        await authenticator.present(true)
        await expect(first.page).toHaveURL(/\/account/)
        await expect(first.page.getByText(account.email)).toBeVisible()
    } finally {
        await first.context.close()
    }
})

test('after the password the passkey is the second step', async ({ browser, sink }) => {
    const { account, first, authenticator } = await enrolled(browser, sink)
    try {
        await first.context.clearCookies()
        // The password, with the autofill request waiting; then the passkey as the second step.
        await authenticator.present(false)
        await signInPassword(first.page, account)
        const form = first.page.getByTestId('mfa-challenge')
        await expect(form).toBeVisible()
        await expect(form.getByTestId('mfa-code')).toHaveCount(0)
        await authenticator.present(true)
        await form.getByTestId('mfa-submit').click()
        await expect(first.page).toHaveURL(/\/account/)
        await expect(first.page.getByText(account.email)).toBeVisible()
    } finally {
        await first.context.close()
    }
})

test('recovery: the lost passkey replaced, removed, new codes, sign in again', async ({
    browser,
    sink,
}) => {
    const { account, first, codes } = await enrolled(browser, sink)
    await first.context.close()

    // Another browser, its own authenticator: the old passkey is not here.
    const { page, context } = await newBrowser(browser)
    try {
        const authenticator = await withAuthenticator(page)
        await signInPassword(page, account)
        await page.getByTestId('mfa-use-recovery').click()
        await page.getByTestId('mfa-code').fill(codes[9] ?? '')
        await page.getByTestId('mfa-submit').click()
        await expect(page.getByTestId('mfa-recovery')).toBeVisible()

        await page.getByTestId('passkey-add').click()
        await expect(page.getByTestId('passkey-item')).toHaveCount(2)
        // The lost one (the first in the list) goes now that the replacement is in.
        await page.getByTestId('passkey-item').first().getByTestId('passkey-remove').click()
        await page.getByTestId('confirm-accept').click()
        await expect(page.getByTestId('passkey-item')).toHaveCount(1)

        await security(page).getByTestId('mfa-regenerate').click()
        await expect(security(page).getByTestId('mfa-codes').locator('li')).toHaveCount(10)
        // The sign-in page after the finish would take the new passkey from the autofill at
        // once: the authenticator waits, so the password comes first.
        await authenticator.present(false)
        await security(page).getByTestId('mfa-recovery-finish').click()
        await expect(page).toHaveURL(/\/login/)

        // An ordinary sign-in: the password (the autofill waiting), then the new passkey.
        await signInPassword(page, account)
        await expect(page.getByTestId('mfa-challenge')).toBeVisible()
        await authenticator.present(true)
        await page.getByTestId('mfa-submit').click()
        await expect(page).toHaveURL(/\/account/)
        await expect(page.getByTestId('mfa-recovery')).toHaveCount(0)
    } finally {
        await context.close()
    }
})
