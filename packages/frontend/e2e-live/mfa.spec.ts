import { createHmac } from 'node:crypto'
import type { Page } from '@playwright/test'

import { createVerifiedAccount, expect, newBrowser, test } from './support'
import type { Account } from './support'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р4, Р8, Р15, tasks M13) against the real backend: an
// authenticator app set up from the account page, the two-step sign-in, a password change
// confirmed by the app in the step-up dialog, and the whole recovery path (the only app lost,
// the last recovery code, a new app, new codes, an ordinary sign-in). The test computes the TOTP
// codes from the key the setup shows, like the app would.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const fromBase32 = (text: string): Buffer => {
    let bits = 0
    let value = 0
    const out: number[] = []
    for (const char of text.replace(/=+$/, '')) {
        value = (value << 5) | BASE32.indexOf(char)
        bits += 5
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255)
            bits -= 8
        }
    }
    return Buffer.from(out)
}
/** The code of the step `offset` steps from now (30 s each). */
const totp = (secret: string, offset = 0): string => {
    const counter = Buffer.alloc(8)
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset))
    const digest = createHmac('sha1', fromBase32(secret)).update(counter).digest()
    const at = (digest[digest.length - 1] ?? 0) & 0x0f
    const binary =
        (((digest[at] ?? 0) & 0x7f) << 24) |
        ((digest[at + 1] ?? 0) << 16) |
        ((digest[at + 2] ?? 0) << 8) |
        (digest[at + 3] ?? 0)
    return String(binary % 1_000_000).padStart(6, '0')
}

const security = (page: Page) => page.getByTestId('mfa-settings')

async function signInPassword(page: Page, account: Account): Promise<void> {
    await page.goto('/login')
    await page.locator('#login-identifier').fill(account.email)
    await page.locator('#login-password').fill(account.password)
    await page
        .locator('button.auth-button', { has: page.locator('span', { hasText: 'Sign In' }) })
        .click()
}

/** Sets the app up from the account page; answers its key and the recovery codes shown once. */
async function setUpApp(
    page: Page,
    account: Account,
): Promise<{ secret: string; codes: string[] }> {
    await security(page).getByTestId('mfa-setup-start').click()
    // The first factor needs a fresh password: the step-up dialog asks for it.
    const dialog = page.getByTestId('reauth-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('reauth-password').fill(account.password)
    await dialog.getByTestId('reauth-submit').click()
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
        await signInPassword(page, account)
        await page.goto('/account')
        const { secret } = await setUpApp(page, account)
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

test('a password change is confirmed with the app in the step-up dialog', async ({
    browser,
    sink,
}) => {
    const account = await createVerifiedAccount(browser, sink)
    const { page, context } = await newBrowser(browser)
    try {
        await signInPassword(page, account)
        await page.goto('/account')
        const { secret } = await setUpApp(page, account)

        const newPassword = 'live-e2e-pass-new-1'
        const passwords = page.locator('input[type="password"]')
        await passwords.nth(0).fill(newPassword)
        await passwords.nth(1).fill(newPassword)
        await page.getByRole('button', { name: 'Update password' }).click()
        const dialog = page.getByTestId('reauth-dialog')
        await expect(dialog).toBeVisible()
        // With MFA the password is not one of the proofs: only the app is offered.
        await expect(dialog.getByTestId('reauth-password')).toHaveCount(0)
        await dialog.getByTestId('reauth-code').fill(totp(secret, 1))
        await dialog.getByTestId('reauth-submit').click()
        await expect(page.getByText('Password updated', { exact: true })).toBeVisible()
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
        await signInPassword(first.page, account)
        await first.page.goto('/account')
        ;({ codes } = await setUpApp(first.page, account))
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
