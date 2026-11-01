import { clickWhereItIs, expect, fieldError, formError, openLogin, test } from './support.js'
import type { Locator, Page } from '@playwright/test'
import type { Api } from './support.js'

// feat-069 (G2): "Forgot password?" on faked API answers. See support.ts.

const GENERIC = 'If an account with that email exists, a reset link will be sent shortly.'

async function openForgot(page: Page, typed = ''): Promise<Locator> {
    const modal = await openLogin(page)
    if (typed !== '') await modal.locator('#login-identifier').fill(typed)
    await modal.getByText('Forgot password?').click()
    await expect(modal.locator('#forgot-identifier')).toBeVisible()
    return modal
}

test.describe('forgot password by e-mail', () => {
    test('what was typed in the login field is carried over, trimmed', async ({ page }) => {
        const modal = await openForgot(page, '  jane@example.com ')
        await expect(modal.locator('#forgot-identifier')).toHaveValue('jane@example.com')
        await expect(modal.getByRole('heading')).toHaveText('Reset password')
    })

    test('a sent request shows the generic text, whoever the address belongs to', async ({
        page,
        api,
    }) => {
        await api.answer('auth/forgot-password', 200, { status: 'success', message: GENERIC })
        const modal = await openForgot(page)
        await modal.locator('#forgot-identifier').fill('jane@example.com')
        await modal.getByRole('button', { name: 'Send reset link' }).click()

        await expect(modal.getByRole('heading')).toHaveText('Check your inbox')
        await expect(modal.getByText(GENERIC)).toBeVisible()
        expect(api.callsTo('auth/forgot-password')).toEqual([
            {
                method: 'POST',
                path: '/api/auth/forgot-password',
                body: { email: 'jane@example.com' },
            },
        ])
    })

    for (const status of [400, 404, 422]) {
        test(`an answer ${String(status)} still shows the generic text: the step does not tell`, async ({
            page,
            api,
        }) => {
            await api.answer('auth/forgot-password', status, {
                status: 'error',
                code: 'bad_request',
                message: 'something specific',
            })
            const modal = await openForgot(page)
            await modal.locator('#forgot-identifier').fill('nobody@example.com')
            await modal.getByRole('button', { name: 'Send reset link' }).click()

            await expect(modal.getByRole('heading')).toHaveText('Check your inbox')
            await expect(modal.getByText('something specific')).toHaveCount(0)
        })
    }

    test('a 429 asks to wait a minute and stays on the step', async ({ page, api }) => {
        await api.answer('auth/forgot-password', 429, {
            status: 'error',
            code: 'rate_limited',
            message: 'Too many requests',
        })
        const modal = await openForgot(page)
        await modal.locator('#forgot-identifier').fill('jane@example.com')
        await modal.getByRole('button', { name: 'Send reset link' }).click()

        await expect(formError(modal)).toHaveText(
            'Too many reset attempts. Please wait a minute and try again.',
        )
        await expect(modal.locator('#forgot-identifier')).toBeVisible()
        await expect(modal.getByRole('button', { name: 'Send reset link' })).toBeEnabled()
    })

    test('a 500 shows the generic server error, not the server text', async ({ page, api }) => {
        await api.answer('auth/forgot-password', 500, {
            status: 'error',
            code: 'internal_error',
            message: 'Failed to enforce forgot password throttle',
        })
        const modal = await openForgot(page)
        await modal.locator('#forgot-identifier').fill('jane@example.com')
        await modal.getByRole('button', { name: 'Send reset link' }).click()

        await expect(formError(modal)).toHaveText('Server error. Please try again later.')
    })

    test('a second click while the request is in flight sends nothing: one request', async ({
        page,
        api,
    }) => {
        await api.answer(
            'auth/forgot-password',
            200,
            { status: 'success', message: GENERIC },
            { delayMs: 600 },
        )
        const modal = await openForgot(page)
        await modal.locator('#forgot-identifier').fill('jane@example.com')
        await modal.getByRole('button', { name: 'Send reset link' }).click()
        const busy = modal.getByRole('button', { name: 'Sending link...' })
        await expect(busy).toBeDisabled()
        await clickWhereItIs(page, busy)

        await expect(modal.getByRole('heading')).toHaveText('Check your inbox')
        expect(api.callsTo('auth/forgot-password')).toHaveLength(1)
    })

    test('client-side validation sends no request', async ({ page, api }) => {
        const modal = await openForgot(page)
        await modal.getByRole('button', { name: 'Send reset link' }).click()
        await expect(fieldError(modal, 'forgot-identifier')).toHaveText(
            'Email or phone is required',
        )

        await modal.locator('#forgot-identifier').fill('not-an-address')
        await modal.getByRole('button', { name: 'Send reset link' }).click()
        await expect(fieldError(modal, 'forgot-identifier')).toHaveText(
            'Enter a valid email address or phone number',
        )
        expect(api.calls).toEqual([])
    })

    test('"Back to sign in" returns to the login step', async ({ page }) => {
        const modal = await openForgot(page)
        await modal.getByText('Back to sign in').click()
        await expect(modal.locator('#login-identifier')).toBeVisible()
        await expect(modal.getByRole('heading')).toHaveText('Sign In')
    })
})

test.describe('forgot password by phone', () => {
    const START = 'auth/reset-phone/start'
    const COMPLETE = 'auth/reset-phone/complete'
    const STARTED = {
        status: 'success',
        message:
            'If the phone number can be used for password reset, verification instructions will be sent shortly.',
        challengeId: 'ch-1',
        expiresAt: '2030-01-01T00:10:00.000Z',
        resendAvailableAt: '2030-01-01T00:01:00.000Z',
    }

    async function toCodeStep(page: Page, api: Api) {
        await api.answer(START, 200, STARTED)
        const modal = await openForgot(page)
        await modal.locator('#forgot-identifier').fill('+15551234567')
        await modal.getByRole('button', { name: 'Send reset link' }).click()
        await expect(modal.locator('#forgot-phone-code')).toBeVisible()
        return modal
    }

    test('a phone number starts the SMS flow and opens the code step', async ({ page, api }) => {
        const modal = await toCodeStep(page, api)
        await expect(modal.getByRole('heading')).toHaveText('Phone recovery')
        expect(api.callsTo(START)).toEqual([
            { method: 'POST', path: `/api/${START}`, body: { phone: '+15551234567' } },
        ])
    })

    test('an answer without a challenge is shown as "check your inbox"', async ({ page, api }) => {
        // The server hides whether the number exists by answering the same text; a number
        // without a challenge ends on the same sent-step as an e-mail.
        await api.answer(START, 200, { status: 'success', message: STARTED.message })
        const modal = await openForgot(page)
        await modal.locator('#forgot-identifier').fill('+15551234567')
        await modal.getByRole('button', { name: 'Send reset link' }).click()
        await expect(modal.getByRole('heading')).toHaveText('Check your inbox')
    })

    test('a 429 asks to wait a minute', async ({ page, api }) => {
        await api.answer(START, 429, { status: 'error', code: 'rate_limited', message: 'x' })
        const modal = await openForgot(page)
        await modal.locator('#forgot-identifier').fill('+15551234567')
        await modal.getByRole('button', { name: 'Send reset link' }).click()
        await expect(formError(modal)).toHaveText(
            'Too many reset attempts. Please wait a minute and try again.',
        )
    })

    test('a wrong code shows the server message and keeps the step and the typed values', async ({
        page,
        api,
    }) => {
        const modal = await toCodeStep(page, api)
        await api.answer(COMPLETE, 400, {
            status: 'error',
            code: 'bad_request',
            message: 'Invalid verification code',
        })
        await modal.locator('#forgot-phone-code').fill('000000')
        await modal.locator('#forgot-phone-password').fill('new-password-1')
        await modal.locator('#forgot-phone-password-confirm').fill('new-password-1')
        await modal.getByRole('button', { name: 'Set new password' }).click()

        await expect(formError(modal)).toHaveText('Invalid verification code')
        await expect(modal.locator('#forgot-phone-code')).toHaveValue('000000')
        await expect(modal.locator('#forgot-phone-password')).toHaveValue('new-password-1')
        expect(api.callsTo(COMPLETE)[0]?.body).toEqual({
            challengeId: 'ch-1',
            code: '000000',
            password: 'new-password-1',
            passwordConfirm: 'new-password-1',
        })
    })

    test('a right code sets the password and returns to sign in with a notice', async ({
        page,
        api,
    }) => {
        const modal = await toCodeStep(page, api)
        await api.answer(COMPLETE, 200, { status: 'success' })
        await modal.locator('#forgot-phone-code').fill(' 123456 ')
        await modal.locator('#forgot-phone-password').fill('new-password-1')
        await modal.locator('#forgot-phone-password-confirm').fill('new-password-1')
        await modal.getByRole('button', { name: 'Set new password' }).click()

        await expect(modal.locator('#login-identifier')).toBeVisible()
        await expect(formError(modal)).toHaveText(
            'Password updated successfully. Please sign in with your new password.',
        )
        // The code is trimmed on its way out.
        expect(api.callsTo(COMPLETE)[0]?.body).toMatchObject({ code: '123456' })
    })

    test('client-side validation sends no request', async ({ page, api }) => {
        const modal = await toCodeStep(page, api)
        await modal.locator('#forgot-phone-password').fill('short')
        await modal.locator('#forgot-phone-password-confirm').fill('different')
        await modal.getByRole('button', { name: 'Set new password' }).click()

        await expect(fieldError(modal, 'forgot-phone-code')).toHaveText(
            'Verification code is required',
        )
        await expect(fieldError(modal, 'forgot-phone-password')).toHaveText(
            'Password must be at least 8 characters long',
        )
        await expect(fieldError(modal, 'forgot-phone-password-confirm')).toHaveText(
            'Passwords do not match',
        )
        expect(api.callsTo(COMPLETE)).toEqual([])
    })

    test('"Back to email recovery" forgets the challenge and the typed values', async ({
        page,
        api,
    }) => {
        const modal = await toCodeStep(page, api)
        await modal.locator('#forgot-phone-code').fill('123456')
        await modal.getByRole('button', { name: 'Back to email recovery' }).click()

        await expect(modal.locator('#forgot-identifier')).toBeVisible()
        await api.answer(START, 200, STARTED)
        await modal.getByRole('button', { name: 'Send reset link' }).click()
        await expect(modal.locator('#forgot-phone-code')).toHaveValue('')
    })
})
