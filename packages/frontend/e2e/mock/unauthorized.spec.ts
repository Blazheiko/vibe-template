import { expect, SIGNED_IN, test } from './support.js'

// feat-162 (review 2026-11-10): every 401 used to send the app to the sign-in page, also the
// 401 of a request that has its own answer for the user. See support.ts.

test.describe('a 401 that is an answer, not a lost session', () => {
    test('a revoked session on /verify-email is explained on that page', async ({ page, api }) => {
        api.setSession(SIGNED_IN.user)
        await api.answer('auth/verify-email', 401, {
            status: 'error',
            code: 'unauthorized',
            message: 'Session is no longer valid',
            reason: 'session_revoked',
        })
        api.ignoreOtherRequests()

        await page.goto('/verify-email?token=mailed-token')

        await expect(
            page.getByText('Your session has ended. Sign in again, then open the link again.'),
        ).toBeVisible()
        await expect(page).toHaveURL(/\/verify-email\?token=mailed-token$/)
        expect(api.callsTo('auth/verify-email')).toHaveLength(1)
    })
})
