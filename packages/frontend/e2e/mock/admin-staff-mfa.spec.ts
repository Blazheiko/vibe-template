import { expect, test } from './support.js'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р10; tasks S5) against faked answers: the admin area
// refuses a staff session for the staff MFA rule; the page leaves for the account's security
// section, which says what to do.

const ADMIN = { id: '1', name: 'Admin', email: 'admin@example.test', role: 'admin' }
const REFUSED = (reason: string) => ({
    status: 'error',
    code: 'forbidden',
    message: 'Access denied',
    reason,
})
const MFA_STATUS = (totp: boolean) => ({
    status: 'success',
    totp: { enabled: totp, createdAt: totp ? '2026-11-01T10:00:00.000Z' : null },
    passkeys: 0,
    recoveryCodesRemaining: totp ? 10 : 0,
    recoveryContact: true,
    stepUpProofs: totp ? ['password', 'totp'] : ['password'],
    recovery: null,
})

test.describe('the staff MFA rule in the admin area', () => {
    test.beforeEach(async ({ api }) => {
        api.setSession(ADMIN)
        await api.answer('auth/sign-in-methods', 200, {
            status: 'success',
            hasPassword: true,
            methods: [],
        })
        api.ignoreOtherRequests()
    })

    test('403 mfa_session_required: to the security section, sign in again from there', async ({
        page,
        api,
    }) => {
        await api.answer('admin/users?*', 403, REFUSED('mfa_session_required'))
        await api.answer('account/mfa', 200, MFA_STATUS(true))

        await page.goto('/admin/users')

        await expect(page).toHaveURL(/\/account\?section=security&reason=mfa_session_required$/)
        const notice = page.getByTestId('staff-mfa-notice')
        await expect(notice).toContainText('recent sign-in with your second factor')
        await expect(notice.getByTestId('staff-mfa-sign-in')).toBeVisible()

        // Until a new sign-in the admin area leads straight back to the explanation.
        // An in-app navigation (no reload, which would start the app again).
        await page.evaluate(
            "window.history.pushState({}, '', '/admin/users'); " +
                "window.dispatchEvent(new PopStateEvent('popstate'))",
        )
        await expect(page).toHaveURL(/\/account\?section=security&reason=mfa_session_required$/)
        expect(api.callsTo('admin/users')).toHaveLength(1)
    })

    test('403 mfa_required: the section asks to set up a factor', async ({ page, api }) => {
        await api.answer('admin/knowledge-base*', 403, REFUSED('mfa_required'))
        await api.answer('account/mfa', 200, MFA_STATUS(false))

        await page.goto('/admin/knowledge-base')

        await expect(page).toHaveURL(/\/account\?section=security&reason=mfa_required$/)
        await expect(page.getByTestId('staff-mfa-notice')).toContainText(
            'Your role needs two-step sign-in',
        )
        await expect(page.getByTestId('mfa-setup-start')).toBeEnabled()
    })
})
