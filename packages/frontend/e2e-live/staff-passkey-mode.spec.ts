import type { Page } from '@playwright/test'

import { ORIGIN, USER_2 } from './fixtures'
import { expect, newBrowser, nextTotp, session, test } from './support'

// feat-248 (docs/plan/passkeys-mfa-plan.md, Р10, Д11; tasks X2) against the real backend started
// with MFA_STAFF_FACTOR=passkey (playwright.live-passkey.config.ts, a database of its own), with
// a Chrome virtual authenticator (CDP): the seeded admin signed in with the authenticator app adds
// a passkey, and that TOTP session is still refused by the admin area (mfa_session_required, the
// security section asks for the passkey); signed in again with the passkey, the admin area opens.

/** A platform authenticator with user verification; `present(false)` makes it wait. */
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

async function signInPassword(page: Page): Promise<void> {
    await page.goto('/login')
    await page.locator('#login-identifier').fill(USER_2.email)
    await page.locator('#login-password').fill(USER_2.password)
    const answered = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === '/api/auth/login' &&
            response.request().method() === 'POST',
    )
    await page
        .locator('button.auth-button', { has: page.locator('span', { hasText: 'Sign In' }) })
        .click()
    expect((await answered).status()).toBe(200)
    await expect(page.getByTestId('mfa-challenge')).toBeVisible()
}

/**
 * The second step with the app's code. The database of this run outlives it, so the admin may
 * have a passkey of an earlier run, which the form offers first: switch to the app then.
 */
async function answerWithTotp(page: Page): Promise<void> {
    const useTotp = page.getByTestId('mfa-use-totp')
    if ((await useTotp.count()) > 0) await useTotp.click()
    for (let attempt = 0; ; attempt += 1) {
        const verified = page.waitForResponse(
            (response) =>
                new URL(response.url()).pathname === '/api/auth/mfa/verify' &&
                response.request().method() === 'POST',
        )
        await page.getByTestId('mfa-code').fill(await nextTotp(USER_2.totpSecret))
        await page.getByTestId('mfa-submit').click()
        const status = (await verified).status()
        // A step an earlier run spent is refused once.
        if (status === 200 || attempt >= 1) {
            expect(status).toBe(200)
            return
        }
    }
}

test('passkey mode: the admin area opens for a passkey sign-in, not for a TOTP one', async ({
    browser,
}) => {
    const { context, page } = await newBrowser(browser)
    try {
        const authenticator = await withAuthenticator(page)
        // No passkey in this authenticator yet: the sign-in page's autofill finds nothing.
        await signInPassword(page)
        await answerWithTotp(page)

        // A passkey added on the account page (the TOTP sign-in a moment ago is the proof).
        await page.goto('/account')
        await page.getByTestId('passkey-add').click()
        await expect(page.getByTestId('passkey-message')).toHaveText('The passkey was added.')

        // Keep only this run's passkey: the earlier ones live in authenticators that are gone.
        const tab = session(context.request)
        const listed = (await (await context.request.get('/api/account/passkeys')).json()) as {
            passkeys: { id: string; createdAt: string }[]
        }
        const newest = [...listed.passkeys].sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt),
        )[0]
        for (const key of listed.passkeys) {
            if (key.id === newest.id) continue
            const removed = await context.request.delete(`/api/account/passkeys/${key.id}`, {
                headers: { origin: ORIGIN, 'x-csrf-token': await tab.token() },
            })
            expect(removed.status()).toBe(200)
        }

        // This session was signed in with the app: the admin area refuses it and the security
        // section asks for a sign-in with the passkey.
        await page.goto('/admin/users')
        await expect(page).toHaveURL(/\/account\?section=security&reason=mfa_session_required$/)
        await expect(page.getByTestId('staff-mfa-notice')).toContainText(
            'recent sign-in with your passkey',
        )
        const refused = await context.request.get('/api/admin/users?limit=1')
        expect(refused.status()).toBe(403)
        expect(await refused.json()).toMatchObject({ reason: 'mfa_session_required' })

        // Signed out, then the password (the autofill waiting) and the passkey as the second step.
        await context.clearCookies()
        await authenticator.present(false)
        await signInPassword(page)
        await expect(page.getByTestId('mfa-code')).toHaveCount(0)
        await authenticator.present(true)
        await page.getByTestId('mfa-submit').click()
        await expect(page).toHaveURL(/\/account/)

        await page.goto('/admin/users')
        await expect(page).toHaveURL(/\/admin\/users$/)
        await expect(page.locator('.admin-sidebar')).toBeVisible()
        expect((await context.request.get('/api/admin/users?limit=1')).status()).toBe(200)
    } finally {
        await context.close()
    }
})
