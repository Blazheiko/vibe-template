import type { Page } from '@playwright/test'

import { createVerifiedAccount, expect, newBrowser, test, totpAt } from './support'
import type { Account } from './support'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р4, Р8, Р15, tasks M13) against the real backend: an
// authenticator app set up from the account page, the two-step sign-in, a password change
// allowed by the fresh TOTP of the second step, and the whole recovery path (the only app lost,
// the last recovery code, a new app, new codes, an ordinary sign-in). The test computes the TOTP
// codes from the key the setup shows, like the app would.

/** The code of the step `offset` steps from now (30 s each). */
const totp = (secret: string, offset = 0): string =>
    totpAt(secret, Math.floor(Date.now() / 30_000) + offset)

const security = (page: Page) => page.getByTestId('mfa-settings')

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

/** A sign-in of an account without a second factor: lands on the account page. */
async function signInToAccount(page: Page, account: Account): Promise<void> {
    await signInPassword(page, account)
    await page.goto('/account')
    await expect(page.getByText(account.email)).toBeVisible()
}

/** Sets the app up from the account page; answers its key and the recovery codes shown once. */
async function setUpApp(page: Page): Promise<{ secret: string; codes: string[] }> {
    await security(page).getByTestId('mfa-setup-start').click()
    // The first factor needs a fresh password, and the sign-in a moment ago is one: no dialog.
    await expect(page.getByTestId('reauth-dialog')).toHaveCount(0)
    const secret = (await security(page).getByTestId('mfa-secret').textContent()) ?? ''
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    await security(page).getByTestId('mfa-setup-code').fill(totp(secret))
    await security(page).getByTestId('mfa-setup-confirm').click()
    await expect(security(page).getByTestId('mfa-codes').locator('li')).toHaveCount(10)
    const codes = await security(page).getByTestId('mfa-codes').locator('li').allTextContents()
    return { secret, codes: codes.map((code) => code.trim()) }
}

test('an authenticator app: set up, then sign-in in two steps', async ({ browser, sink }) => {
    const account = await createVerifiedAccount(browser, sink)
    const { page, context } = await newBrowser(browser)
    try {
        await signInToAccount(page, account)
        const { secret } = await setUpApp(page)
        await expect(security(page).getByTestId('mfa-totp-state')).toContainText('is on')

        // A new browser: the password alone opens the second step, not the account.
        const other = await newBrowser(browser)
        try {
            await signInPassword(other.page, account)
            await expect(other.page.getByTestId('mfa-challenge')).toBeVisible()
            await other.page.getByTestId('mfa-code').fill('000000')
            await other.page.getByTestId('mfa-submit').click()
            await expect(other.page.getByRole('alert')).toContainText('incorrect')
            await other.page.getByTestId('mfa-code').fill(totp(secret, 1))
            await other.page.getByTestId('mfa-submit').click()
            await expect(other.page).toHaveURL(/\/account/)
            await expect(other.page.getByText(account.email)).toBeVisible()
        } finally {
            await other.context.close()
        }
    } finally {
        await context.close()
    }
})

test('after the two-step sign-in a password change needs no other proof', async ({
    browser,
    sink,
}) => {
    const account = await createVerifiedAccount(browser, sink)
    const first = await newBrowser(browser)
    let secret: string
    try {
        await signInToAccount(first.page, account)
        ;({ secret } = await setUpApp(first.page))
    } finally {
        await first.context.close()
    }

    // The TOTP of the second step is a fresh proof: the change goes without the dialog. (The
    // dialog for a stale proof is covered by e2e/mfa.spec.ts with a mocked 403.)
    const { page, context } = await newBrowser(browser)
    try {
        await signInPassword(page, account)
        await page.getByTestId('mfa-code').fill(totp(secret, 1))
        await page.getByTestId('mfa-submit').click()
        await expect(page).toHaveURL(/\/account/)
        const newPassword = 'live-e2e-pass-new-1'
        await page.locator('input[name="new-password"]').fill(newPassword)
        await page.locator('input[name="confirm-password"]').fill(newPassword)
        await page.getByRole('button', { name: 'Update password' }).click()
        await expect(page.getByText('Password updated', { exact: true })).toBeVisible()
        await expect(page.getByTestId('reauth-dialog')).toHaveCount(0)
    } finally {
        await context.close()
    }
})

test('recovery: the only app lost, the last code, a new app, new codes, sign in again', async ({
    browser,
    sink,
}) => {
    const account = await createVerifiedAccount(browser, sink)
    const first = await newBrowser(browser)
    let codes: string[]
    try {
        await signInToAccount(first.page, account)
        ;({ codes } = await setUpApp(first.page))
    } finally {
        await first.context.close()
    }

    const { page, context } = await newBrowser(browser)
    try {
        await signInPassword(page, account)
        await page.getByTestId('mfa-use-recovery').click()
        await page.getByTestId('mfa-code').fill(codes[9] ?? '')
        await page.getByTestId('mfa-submit').click()

        // The recovery session: only the wizard.
        await expect(page.getByTestId('mfa-recovery')).toBeVisible()
        await expect(page.getByTestId('active-sessions')).toHaveCount(0)
        await expect(page.getByTestId('mfa-regenerate')).toHaveCount(0)

        await security(page).getByTestId('mfa-setup-start').click()
        const secret = (await security(page).getByTestId('mfa-secret').textContent()) ?? ''
        await security(page).getByTestId('mfa-setup-code').fill(totp(secret))
        await security(page).getByTestId('mfa-setup-confirm').click()
        await expect(security(page).getByTestId('mfa-regenerate')).toBeVisible()
        await security(page).getByTestId('mfa-regenerate').click()
        await expect(security(page).getByTestId('mfa-codes').locator('li')).toHaveCount(10)
        await security(page).getByTestId('mfa-recovery-finish').click()
        await expect(page).toHaveURL(/\/login/)

        // An ordinary sign-in with the new app.
        await signInPassword(page, account)
        await page.getByTestId('mfa-code').fill(totp(secret, 1))
        await page.getByTestId('mfa-submit').click()
        await expect(page).toHaveURL(/\/account/)
        await expect(page.getByTestId('mfa-recovery')).toHaveCount(0)
        await expect(page.getByTestId('active-sessions')).toBeVisible()
    } finally {
        await context.close()
    }
})
