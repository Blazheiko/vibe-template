import { expect, test } from './support.js'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р12, Р13; tasks S2) against faked answers: an admin
// resets the second factors of another account from the users list, with a reason and after the
// step-up dialog; a reset that would leave no way to sign in is explained.

const ADMIN = { id: '1', name: 'Admin', email: 'admin@example.test', role: 'admin' }
const USER = {
    id: '7',
    name: 'Jane',
    email: 'jane@example.test',
    role: 'user',
    registeredAt: '2026-11-01T10:00:00.000Z',
}

test.describe('admin MFA reset', () => {
    test.beforeEach(async ({ api }) => {
        api.setSession(ADMIN)
        await api.answer('admin/users?*', 200, {
            status: 'success',
            items: [{ ...USER, emailVerified: true }],
            total: 1,
            nextCursor: null,
            hasMore: false,
        })
        api.ignoreOtherRequests()
    })

    test('a reason, the step-up, then the reset and its notice', async ({ page, api }) => {
        let calls = 0
        await page.route('**/api/admin/users/7/mfa/reset', async (route) => {
            calls += 1
            const status = calls === 1 ? 403 : 200
            const body =
                calls === 1
                    ? {
                          status: 'error',
                          code: 'forbidden',
                          message: 'Confirm it is you',
                          reason: 'reauth_required',
                          details: { kind: 'reauth_required', proofs: ['password'] },
                      }
                    : {
                          status: 'success',
                          user: { id: '7' },
                          removed: { totp: true, passkeys: 0, recoveryCodes: 10 },
                      }
            await route.fulfill({
                status,
                contentType: 'application/json',
                body: JSON.stringify(body),
            })
        })
        await api.answer('auth/reauth', 200, { status: 'success' })

        await page.goto('/admin/users')
        await page.getByTestId('mfa-reset').click()
        const dialog = page.getByTestId('mfa-reset-dialog')
        await dialog.getByTestId('mfa-reset-reason').fill('lost phone and codes')
        await dialog.getByTestId('mfa-reset-confirm').click()
        const reauth = page.getByTestId('reauth-dialog')
        await reauth.getByTestId('reauth-password').fill('admin-password')
        await reauth.getByTestId('reauth-submit').click()

        await expect(page.getByTestId('mfa-reset-notice')).toContainText('was reset')
        expect(calls).toBe(2)
    })

    test('no other way to sign in: the dialog explains "forgot password" first', async ({
        page,
    }) => {
        await page.route('**/api/admin/users/7/mfa/reset', async (route) => {
            await route.fulfill({
                status: 409,
                contentType: 'application/json',
                body: JSON.stringify({
                    status: 'error',
                    code: 'conflict',
                    message: 'no way in',
                    reason: 'last_sign_in_method',
                }),
            })
        })
        await page.goto('/admin/users')
        await page.getByTestId('mfa-reset').click()
        const dialog = page.getByTestId('mfa-reset-dialog')
        await dialog.getByTestId('mfa-reset-reason').fill('lost the passkey')
        await dialog.getByTestId('mfa-reset-confirm').click()
        await expect(dialog.getByRole('alert')).toContainText('Forgot password')
    })
})
