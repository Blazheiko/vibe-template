import type { Page, Route } from '@playwright/test'

import { expect, openLogin, SIGNED_IN, test } from './support.js'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р6, Р15; tasks P5) against faked answers, with the
// browser's own WebAuthn: a Chrome virtual authenticator (CDP) makes the real ceremonies, the
// server answers are faked. It checks the wiring: the options go to the browser, its answer goes
// back in the request the server expects. e2e-live/passkeys.spec.ts runs the real backend.

const USER = SIGNED_IN.user

const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

/** A platform authenticator with user verification that answers without a prompt. */
async function virtualAuthenticator(page: Page): Promise<void> {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
        },
    })
}

const MFA_STATUS = {
    status: 'success',
    totp: { enabled: false, createdAt: null },
    passkeys: 0,
    recoveryCodesRemaining: 0,
    recoveryContact: true,
    stepUpProofs: ['password'],
    recovery: null,
}

const creationOptions = (rpId: string) => ({
    challenge: 'cmVnaXN0ZXItY2hhbGxlbmdl',
    rp: { name: 'Vibe', id: rpId },
    user: { id: 'dXNlci1oYW5kbGUtMzItYnl0ZXMtbG9uZy14eHh4eHg', name: 'jane', displayName: 'Jane' },
    pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
    timeout: 60000,
    excludeCredentials: [],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    attestation: 'none',
})

test.describe('passkeys in the browser', () => {
    test.use({ locale: 'en-GB' })

    test('adding a passkey: the step-up, the ceremony, the stored key and the codes', async ({
        page,
        api,
    }) => {
        await virtualAuthenticator(page)
        api.setSession(USER)
        await api.answer('auth/sign-in-methods', 200, {
            status: 'success',
            hasPassword: true,
            methods: [],
        })
        await api.answer('account/mfa', 200, MFA_STATUS)
        // The mock app runs on localhost: that is the RP ID of its ceremonies.
        const rpId = 'localhost'
        let listed: unknown[] = []
        await page.route('**/api/account/passkeys', async (route) => {
            if (route.request().method() === 'GET') {
                await json(route, 200, { status: 'success', passkeys: listed })
                return
            }
            const body = route.request().postDataJSON() as {
                enrollmentId: string
                response: { id: string; response: { attestationObject: string } }
            }
            expect(body.enrollmentId).toBe('enrollment-1')
            expect(body.response.response.attestationObject.length).toBeGreaterThan(20)
            const passkey = {
                id: '1',
                name: 'Passkey',
                deviceType: 'singleDevice',
                backedUp: false,
                createdAt: new Date().toISOString(),
                lastUsedAt: null,
            }
            listed = [passkey]
            await json(route, 200, {
                status: 'success',
                passkey,
                recoveryCodes: Array.from({ length: 10 }, (_, i) => `CODE-${String(i)}`),
            })
        })
        let optionsCalls = 0
        await page.route('**/api/account/passkeys/options', async (route) => {
            optionsCalls += 1
            if (optionsCalls === 1) {
                await json(route, 403, {
                    status: 'error',
                    code: 'forbidden',
                    message: 'Confirm it is you',
                    reason: 'reauth_required',
                    details: { kind: 'reauth_required', proofs: ['password'] },
                })
                return
            }
            await json(route, 200, {
                status: 'success',
                enrollmentId: 'enrollment-1',
                options: creationOptions(rpId),
            })
        })
        await api.answer('auth/reauth', 200, { status: 'success' })
        api.ignoreOtherRequests()

        await page.goto('/account')
        expect(new URL(page.url()).hostname).toBe(rpId)
        await page.getByTestId('passkey-add').click()
        const dialog = page.getByTestId('reauth-dialog')
        await dialog.getByTestId('reauth-password').fill('correct-horse')
        await dialog.getByTestId('reauth-submit').click()

        await expect(page.getByTestId('passkey-message')).toHaveText('The passkey was added.')
        await expect(page.getByTestId('passkey-item')).toHaveCount(1)
        await expect(page.getByTestId('mfa-codes').locator('li')).toHaveCount(10)
        expect(optionsCalls).toBe(2)
    })

    test('the second step with a passkey: options of the ticket, the signature, verify', async ({
        page,
        api,
    }) => {
        await virtualAuthenticator(page)
        // A key for this site in the authenticator: made by a ceremony on the page itself.
        await page.goto('/login')
        await page.evaluate(async () => {
            await navigator.credentials.create({
                publicKey: {
                    challenge: new Uint8Array(32),
                    rp: { name: 'Vibe', id: location.hostname },
                    user: { id: new Uint8Array(32), name: 'jane', displayName: 'Jane' },
                    pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
                    authenticatorSelection: {
                        residentKey: 'required',
                        userVerification: 'required',
                    },
                },
            })
        })

        await api.answer('auth/login', 200, {
            status: 'mfa_required',
            methods: ['webauthn', 'totp', 'recovery_code'],
        })
        await api.answer('auth/mfa/webauthn/options', 200, {
            status: 'success',
            options: {
                challenge: 'bWZhLWNoYWxsZW5nZQ',
                rpId: 'localhost',
                allowCredentials: [],
                userVerification: 'required',
            },
        })
        const verified: unknown[] = []
        await page.route('**/api/auth/mfa/verify', async (route) => {
            verified.push(route.request().postDataJSON())
            api.setSession(USER)
            await json(route, 200, SIGNED_IN)
        })
        api.ignoreOtherRequests()

        const modal = await openLogin(page)
        await modal.locator('#login-identifier').fill('jane@example.com')
        await modal.locator('#login-password').fill('correct-horse')
        await modal.getByRole('button', { name: 'Sign In', exact: true }).click()

        const form = page.getByTestId('mfa-challenge')
        await expect(form).toBeVisible()
        await expect(form.getByTestId('mfa-code')).toHaveCount(0)
        await form.getByTestId('mfa-submit').click()

        await expect(page).toHaveURL(/\/account$/)
        expect(verified).toHaveLength(1)
        expect(verified[0]).toMatchObject({
            method: 'webauthn',
            response: { type: 'public-key', response: { signature: expect.any(String) } },
        })
    })
})
