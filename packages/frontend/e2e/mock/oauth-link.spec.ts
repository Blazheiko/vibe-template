import type { Route } from '@playwright/test'
import { expect, SIGNED_IN, test } from './support.js'

// feat-097: OAuth pre-hijack protection on faked API answers. See support.ts.

test.describe('OAuth sign-in into an existing account', () => {
    test('link_pending tells the user to open the mailed link in this browser', async ({
        page,
    }) => {
        await page.goto('/?oauth=link_pending')

        await expect(page.getByRole('status')).toHaveText(
            'An account with this email already exists. We sent a confirmation link to that email: open it in this browser to finish signing in.',
        )
        await expect(page).toHaveURL(/\/$/)
    })

    test('an error reason the user can act on is explained', async ({ page }) => {
        await page.goto('/?error=oauth_failed&reason=oauth_already_linked')

        await expect(page.getByRole('alert')).toHaveText(
            'This sign-in method is already linked to another account.',
        )
    })

    test('a spent mail budget is explained (feat-098)', async ({ page }) => {
        await page.goto('/?error=oauth_failed&reason=too_many_attempts')

        await expect(page.getByRole('alert')).toHaveText(
            'Too many sign-in emails were sent. Please try again later.',
        )
    })

    test('the confirmation page signs in and opens the account', async ({ page, api }) => {
        await api.answer(
            'auth/oauth/link/confirm',
            200,
            { status: 'success', csrfToken: SIGNED_IN.csrfToken },
            {
                onRequest: () => {
                    api.setSession(SIGNED_IN.user)
                },
            },
        )
        api.ignoreOtherRequests()

        await page.goto('/oauth/link/confirm?token=link-token')

        await expect(page).toHaveURL(/\/account$/)
        expect(api.callsTo('auth/oauth/link/confirm')).toEqual([
            {
                method: 'POST',
                path: '/api/auth/oauth/link/confirm',
                body: { token: 'link-token' },
            },
        ])
    })

    test('the confirmation page opened in another browser says where to open it', async ({
        page,
        api,
    }) => {
        await api.answer('auth/oauth/link/confirm', 403, {
            status: 'error',
            code: 'forbidden',
            message: 'Open this link in the browser where you started signing in',
            reason: 'oauth_link_wrong_session',
        })

        await page.goto('/oauth/link/confirm?token=link-token')

        await expect(page.getByRole('heading')).toHaveText('Could not confirm the sign-in')
        await expect(page.getByRole('alert')).toContainText(
            'Open this link in the browser where you started signing in.',
        )
    })
})

test.describe('registration link without a session', () => {
    test('asks for the password, refuses a wrong one, accepts the right one', async ({ page }) => {
        const bodies: unknown[] = []
        await page.route('**/api/auth/verify-email', async (route: Route) => {
            const body = route.request().postDataJSON() as { token: string; password?: string }
            bodies.push(body)
            const reply =
                body.password === undefined
                    ? {
                          status: 403,
                          json: {
                              status: 'error',
                              code: 'forbidden',
                              message: 'Enter the password of this account to confirm the email',
                              reason: 'password_required',
                          },
                      }
                    : body.password === 'right-password'
                      ? { status: 200, json: { status: 'success', message: 'Email verified' } }
                      : {
                            status: 400,
                            json: {
                                status: 'error',
                                code: 'bad_request',
                                message: 'Password is incorrect',
                                reason: 'invalid_password',
                            },
                        }
            await route.fulfill({
                status: reply.status,
                contentType: 'application/json',
                body: JSON.stringify(reply.json),
            })
        })

        await page.goto('/verify-email?token=reg-token')
        const password = page.getByLabel('Password')
        await expect(password).toBeVisible()

        await password.fill('wrong-password')
        await page.getByRole('button', { name: 'Confirm email' }).click()
        await expect(page.getByRole('alert')).toHaveText('The password is incorrect.')

        await password.fill('right-password')
        await page.getByRole('button', { name: 'Confirm email' }).click()
        await expect(page.getByRole('heading')).toHaveText('Email confirmed')

        expect(bodies).toEqual([
            { token: 'reg-token' },
            { token: 'reg-token', password: 'wrong-password' },
            { token: 'reg-token', password: 'right-password' },
        ])
    })
})
