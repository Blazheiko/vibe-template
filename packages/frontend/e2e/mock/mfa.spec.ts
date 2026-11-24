import type { Route } from '@playwright/test'

import { CSRF_TOKEN, expect, NO_PREFERENCES, openLogin, SIGNED_IN, test } from './support.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р4, Р15; tasks M12) against faked answers: the
// second sign-in step and the step-up dialog. A real backend gives a fresh proof at every
// sign-in, so the stale-proof path (403 reauth_required → dialog → the same request again) is
// only reachable here; e2e-live/mfa.spec.ts runs the real flows.

const USER = SIGNED_IN.user

const MFA_STATUS = {
    status: 'success',
    totp: { enabled: true, createdAt: '2026-11-01T10:00:00.000Z' },
    passkeys: 0,
    recoveryCodesRemaining: 8,
    recoveryContact: true,
    stepUpProofs: ['totp'],
    recovery: null,
    staffFactor: null,
}

const reauthRequired = (proofs: string[]) => ({
    status: 'error',
    code: 'forbidden',
    message: 'Confirm it is you',
    reason: 'reauth_required',
    details: { kind: 'reauth_required', proofs },
})

const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

test.describe('second sign-in step', () => {
    test('the password opens the code form; a wrong code is said, the right one signs in', async ({
        page,
        api,
    }) => {
        await api.answer('auth/login', 200, {
            status: 'mfa_required',
            methods: ['totp', 'recovery_code'],
        })
        let attempts = 0
        await page.route('**/api/auth/mfa/verify', async (route) => {
            attempts += 1
            if (attempts === 1) {
                await json(route, 400, {
                    status: 'error',
                    code: 'bad_request',
                    message: 'no',
                    reason: 'invalid_code',
                })
                return
            }
            api.setSession(USER)
            await json(route, 200, SIGNED_IN)
        })
        api.ignoreOtherRequests()

        const modal = await openLogin(page)
        await modal.locator('#login-identifier').fill('jane@example.com')
        await modal.locator('#login-password').fill('correct-horse')
        await modal.getByRole('button', { name: 'Sign In' }).click()

        const form = page.getByTestId('mfa-challenge')
        await expect(form).toBeVisible()
        await form.getByTestId('mfa-code').fill('111111')
        await form.getByTestId('mfa-submit').click()
        await expect(form.getByRole('alert')).toHaveText('The code is incorrect or already used')

        await form.getByTestId('mfa-code').fill('222222')
        await form.getByTestId('mfa-submit').click()
        await expect(page).toHaveURL(/\/account$/)
        expect(attempts).toBe(2)
    })

    test('a server finishing the sign-in (503 mfa_completion_pending) is asked again', async ({
        page,
        api,
    }) => {
        await api.answer('auth/login', 200, { status: 'mfa_required', methods: ['totp'] })
        const bodies: unknown[] = []
        await page.route('**/api/auth/mfa/verify', async (route) => {
            bodies.push(route.request().postDataJSON())
            if (bodies.length === 1) {
                await json(route, 503, {
                    status: 'error',
                    code: 'service_unavailable',
                    message: 'later',
                    reason: 'mfa_completion_pending',
                })
                return
            }
            api.setSession(USER)
            await json(route, 200, SIGNED_IN)
        })
        api.ignoreOtherRequests()

        const modal = await openLogin(page)
        await modal.locator('#login-identifier').fill('jane@example.com')
        await modal.locator('#login-password').fill('correct-horse')
        await modal.getByRole('button', { name: 'Sign In' }).click()
        await page.getByTestId('mfa-code').fill('123456')
        await page.getByTestId('mfa-submit').click()

        await expect(page).toHaveURL(/\/account$/)
        // The same request twice: the repeat finishes the sign-in the server confirmed. feat-256:
        // one logical attempt, so the same attemptId.
        const attempt = { method: 'totp', code: '123456', attemptId: expect.any(String) }
        expect(bodies).toEqual([attempt, attempt])
        const ids = (bodies as { attemptId: string }[]).map((body) => body.attemptId)
        expect(new Set(ids).size).toBe(1)
    })

    test('a reload during the second step shows the code form again, no new password', async ({
        page,
        api,
    }) => {
        await api.answer('auth/login', 200, {
            status: 'mfa_required',
            methods: ['totp', 'recovery_code'],
        })
        // The ticket cookie survives the reload; the server says so for this browser.
        let ticket = false
        await page.route('**/api/auth/mfa/state', async (route) => {
            await json(
                route,
                200,
                ticket
                    ? { status: 'mfa_required', methods: ['totp', 'recovery_code'] }
                    : { status: 'none' },
            )
        })
        const bodies: unknown[] = []
        await page.route('**/api/auth/mfa/verify', async (route) => {
            bodies.push(route.request().postDataJSON())
            api.setSession(USER)
            await json(route, 200, SIGNED_IN)
        })
        api.ignoreOtherRequests()

        const modal = await openLogin(page)
        await modal.locator('#login-identifier').fill('jane@example.com')
        await modal.locator('#login-password').fill('correct-horse')
        await modal.getByRole('button', { name: 'Sign In' }).click()
        await expect(page.getByTestId('mfa-challenge')).toBeVisible()
        ticket = true

        await page.reload()
        await expect(page.getByTestId('mfa-challenge')).toBeVisible()
        await expect(page.locator('#login-password')).toHaveCount(0)
        await page.getByTestId('mfa-code').fill('123456')
        await page.getByTestId('mfa-submit').click()

        await expect(page).toHaveURL(/\/account$/)
        expect(bodies).toEqual([{ method: 'totp', code: '123456', attemptId: expect.any(String) }])
        // The password was sent once: the reload did not start a new sign-in.
        expect(api.callsTo('auth/login')).toHaveLength(1)
    })

    test('a recovery code opens only the recovery wizard: no refused route is asked', async ({
        page,
        api,
    }) => {
        await api.answer('auth/login', 200, {
            status: 'mfa_required',
            methods: ['totp', 'recovery_code'],
        })
        let recovering = false
        await page.route('**/api/auth/mfa/verify', async (route) => {
            recovering = true
            // Р8: the answer carries the recovery state; the client stores it before navigating.
            await json(route, 200, {
                ...SIGNED_IN,
                recovery: { expiresAt: '2026-11-22T12:15:00.000Z', replaced: false },
            })
        })
        // main/init of a recovery session: no WebSocket, `recovery` set.
        await page.route('**/api/main/init', async (route) => {
            if (!recovering) {
                await route.fallback()
                return
            }
            await json(route, 200, {
                status: 'ok',
                user: { ...USER, preferences: NO_PREFERENCES, revision: '0' },
                csrfToken: CSRF_TOKEN,
                recovery: { expiresAt: '2026-11-22T12:15:00.000Z', replaced: false },
            })
        })
        const refused = {
            status: 'error',
            code: 'forbidden',
            message: 'no',
            reason: 'recovery_session',
        }
        await api.answer('account/sessions', 403, refused)
        await api.answer('auth/sign-in-methods', 403, refused)
        await api.answer('account/mfa', 200, {
            ...MFA_STATUS,
            stepUpProofs: [],
            recovery: { expiresAt: '2026-11-22T12:15:00.000Z', replaced: false },
        })
        api.ignoreOtherRequests()

        const modal = await openLogin(page)
        await modal.locator('#login-identifier').fill('jane@example.com')
        await modal.locator('#login-password').fill('correct-horse')
        await modal.getByRole('button', { name: 'Sign In' }).click()
        await page.getByTestId('mfa-use-recovery').click()
        await page.getByTestId('mfa-code').fill('ABCD-EFGH-JKMN-PQRS')
        await page.getByTestId('mfa-submit').click()

        await expect(page.getByTestId('mfa-recovery')).toBeVisible()
        await expect(page.getByTestId('active-sessions')).toHaveCount(0)
        expect(api.callsTo('account/sessions')).toEqual([])
        expect(api.callsTo('auth/sign-in-methods')).toEqual([])
    })
})

test.describe('step-up dialog', () => {
    test.use({ locale: 'en-GB' })

    test.beforeEach(async ({ api }) => {
        api.setSession(USER)
        await api.answer('auth/sign-in-methods', 200, {
            status: 'success',
            hasPassword: true,
            methods: [],
        })
        await api.answer('account/mfa', 200, MFA_STATUS)
        api.ignoreOtherRequests()
    })

    test('a stale proof: the dialog asks for the app code only, then the change goes again', async ({
        page,
        api,
    }) => {
        const changes: unknown[] = []
        await page.route('**/api/auth/change-password', async (route) => {
            changes.push(route.request().postDataJSON())
            if (changes.length === 1) {
                await json(route, 403, reauthRequired(['totp']))
                return
            }
            await json(route, 200, SIGNED_IN)
        })
        await api.answer('auth/reauth', 200, { status: 'success' })

        await page.goto('/account')
        await page.locator('input[name="new-password"]').fill('new-pass-word-1')
        await page.locator('input[name="confirm-password"]').fill('new-pass-word-1')
        await page.getByRole('button', { name: 'Update password' }).click()

        const dialog = page.getByTestId('reauth-dialog')
        await expect(dialog).toBeVisible()
        await expect(dialog.getByTestId('reauth-password')).toHaveCount(0)
        await dialog.getByTestId('reauth-code').fill('654321')
        await dialog.getByTestId('reauth-submit').click()

        await expect(page.getByText('Password updated', { exact: true })).toBeVisible()
        await expect(dialog).toHaveCount(0)
        expect(api.callsTo('auth/reauth')).toEqual([
            {
                method: 'POST',
                path: '/api/auth/reauth',
                body: { proof: 'totp', code: '654321' },
            },
        ])
        // No current password travels with the change any more.
        expect(changes).toHaveLength(2)
        expect(changes[1]).toEqual(changes[0])
        expect(changes[0]).not.toHaveProperty('currentPassword')
    })

    test('a cancelled dialog sends nothing again', async ({ page }) => {
        let changes = 0
        await page.route('**/api/auth/change-password', async (route) => {
            changes += 1
            await json(route, 403, reauthRequired(['password']))
        })

        await page.goto('/account')
        await page.locator('input[name="new-password"]').fill('new-pass-word-1')
        await page.locator('input[name="confirm-password"]').fill('new-pass-word-1')
        await page.getByRole('button', { name: 'Update password' }).click()

        const dialog = page.getByTestId('reauth-dialog')
        await expect(dialog.getByTestId('reauth-password')).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        expect(changes).toBe(1)
    })
})
