import type { APIRequestContext, Page } from '@playwright/test'

import { REAUTH_WINDOW_SECONDS_SHORT } from './fixtures'
import {
    createVerifiedAccount,
    enrollTotp,
    expect,
    loginInUi,
    newBrowser,
    nextTotp,
    session,
    test,
    withAuthenticator,
} from './support'
import type { Account } from './support'

// feat-245/feat-246 (docs/plan/passkeys-mfa-plan.md, Р3, Р15; tasks M13, P5) against the real
// backend: the step-up dialog itself. A sign-in is a fresh proof for AUTH_REAUTH_WINDOW_SECONDS,
// so this spec runs under playwright.live-passkey.config.ts, whose backend has the shortest window
// (30 s), and waits it out: the password change then answers 403 reauth_required, ReauthDialog
// offers only the factor the account has (the app's code, or the passkey), and once it is given
// the same change goes through. Ordinary accounts: the staff passkey mode of that run does not
// apply to them.

/**
 * Lets the proof of the sign-in age out of the step-up window. The wait runs in the test process,
 * not in the page, whose timers the browser may throttle.
 */
const ageOutProof = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, (REAUTH_WINDOW_SECONDS_SHORT + 1) * 1000))

/** The password change of the account page; answers the new password. */
async function changePassword(page: Page): Promise<string> {
    const newPassword = 'live-e2e-pass-stepped-up'
    await page.locator('input[name="new-password"]').fill(newPassword)
    await page.locator('input[name="confirm-password"]').fill(newPassword)
    await page.getByRole('button', { name: 'Update password' }).click()
    return newPassword
}

/** The new password signs in (and still asks for the second step). */
async function expectPasswordChanged(
    request: APIRequestContext,
    account: Account,
    password: string,
) {
    const answer = await session(request).post('/api/auth/login', {
        identifier: account.email,
        password,
    })
    expect(answer.status()).toBe(200)
    expect(await answer.json()).toMatchObject({ status: 'mfa_required' })
}

test('a stale proof: the password change asks for the app code, then goes through', async ({
    browser,
    sink,
}) => {
    test.setTimeout(120_000)
    const account = await createVerifiedAccount(browser, sink)
    const first = await newBrowser(browser)
    let secret: string
    try {
        await loginInUi(first.page, account)
        secret = await enrollTotp(first.context.request)
    } finally {
        await first.context.close()
    }

    const { page, context } = await newBrowser(browser)
    try {
        // The two-step sign-in: a fresh TOTP proof, then it ages out.
        await loginInUi(page, { ...account, totpSecret: secret })
        await ageOutProof()

        const newPassword = await changePassword(page)
        const dialog = page.getByTestId('reauth-dialog')
        await expect(dialog).toBeVisible()
        // Only the app's code: no password field, no passkey, no choice between proofs.
        await expect(dialog.getByTestId('reauth-code')).toBeVisible()
        await expect(dialog.getByTestId('reauth-password')).toHaveCount(0)
        await expect(dialog.getByTestId('reauth-passkey')).toHaveCount(0)
        await expect(dialog.locator('[data-testid^="reauth-proof-"]')).toHaveCount(0)

        const steppedUp = page.waitForResponse(
            (response) =>
                new URL(response.url()).pathname === '/api/auth/reauth' &&
                response.request().method() === 'POST',
        )
        await dialog.getByTestId('reauth-code').fill(await nextTotp(secret))
        await dialog.getByTestId('reauth-submit').click()
        expect((await steppedUp).status()).toBe(200)

        await expect(dialog).toHaveCount(0)
        await expect(page.getByText('Password updated', { exact: true })).toBeVisible()
        const other = await newBrowser(browser)
        try {
            await expectPasswordChanged(other.context.request, account, newPassword)
        } finally {
            await other.context.close()
        }
    } finally {
        await context.close()
    }
})

test('a stale proof: the password change asks for the passkey, then goes through', async ({
    browser,
    sink,
}) => {
    test.setTimeout(120_000)
    const account = await createVerifiedAccount(browser, sink)
    const { page, context } = await newBrowser(browser)
    try {
        const authenticator = await withAuthenticator(page)
        await loginInUi(page, account)
        await page.getByTestId('passkey-add').click()
        await expect(page.getByTestId('passkey-message')).toHaveText('The passkey was added.')

        // Signed out, then the password (the autofill waiting) and the passkey as the second
        // step: a fresh passkey proof, then it ages out.
        await context.clearCookies()
        await authenticator.present(false)
        await page.goto('/login')
        await page.locator('#login-identifier').fill(account.email)
        await page.locator('#login-password').fill(account.password)
        await page
            .locator('button.auth-button', { has: page.locator('span', { hasText: 'Sign In' }) })
            .click()
        await expect(page.getByTestId('mfa-challenge')).toBeVisible()
        await authenticator.present(true)
        await page.getByTestId('mfa-submit').click()
        await expect(page).toHaveURL(/\/account/)
        await expect(page.getByText(account.email)).toBeVisible()
        await ageOutProof()

        const newPassword = await changePassword(page)
        const dialog = page.getByTestId('reauth-dialog')
        await expect(dialog).toBeVisible()
        // Only the passkey: no code, no password field, no choice between proofs.
        await expect(dialog.getByTestId('reauth-passkey')).toBeVisible()
        await expect(dialog.getByTestId('reauth-code')).toHaveCount(0)
        await expect(dialog.getByTestId('reauth-password')).toHaveCount(0)
        await expect(dialog.locator('[data-testid^="reauth-proof-"]')).toHaveCount(0)

        const steppedUp = page.waitForResponse(
            (response) =>
                new URL(response.url()).pathname === '/api/auth/reauth' &&
                response.request().method() === 'POST',
        )
        // The virtual authenticator answers the ceremony with the user present.
        await dialog.getByTestId('reauth-submit').click()
        expect((await steppedUp).status()).toBe(200)

        await expect(dialog).toHaveCount(0)
        await expect(page.getByText('Password updated', { exact: true })).toBeVisible()
        const other = await newBrowser(browser)
        try {
            await expectPasswordChanged(other.context.request, account, newPassword)
        } finally {
            await other.context.close()
        }
    } finally {
        await context.close()
    }
})
