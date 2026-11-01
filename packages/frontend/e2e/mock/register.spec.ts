import {
    clickWhereItIs,
    expect,
    fieldError,
    formError,
    openRegister,
    SIGNED_IN,
    test,
} from './support.js'
import type { Locator, Page } from '@playwright/test'
import type { Api } from './support.js'

// feat-069 (G2): the register modal on faked API answers. The build behind these specs has
// phone auth on (playwright.config.ts), so the modal opens on the choice step. See support.ts.

const STRICT_ANSWER = {
    status: 'success',
    message:
        'If the email can be used for registration, continue with the verification instructions sent to your inbox.',
}

async function fillEmailForm(
    modal: Locator,
    values: Partial<{
        name: string
        email: string
        password: string
        confirm: string
        terms: boolean
    }> = {},
): Promise<void> {
    const v = {
        name: 'Jane Doe',
        email: 'jane@example.com',
        password: 'correct-horse',
        confirm: 'correct-horse',
        terms: true,
        ...values,
    }
    await modal.locator('#register-name').fill(v.name)
    await modal.locator('#register-email').fill(v.email)
    await modal.locator('#register-password').fill(v.password)
    await modal.locator('#register-password-confirm').fill(v.confirm)
    if (v.terms) await acceptTerms(modal)
}

async function openEmailForm(page: Page): Promise<Locator> {
    const modal = await openRegister(page)
    await modal.getByRole('button', { name: 'Continue with email' }).click()
    await expect(modal.locator('#register-name')).toBeVisible()
    return modal
}

// The checkbox itself is hidden behind a styled mark; a user clicks the label.
async function acceptTerms(modal: Locator): Promise<void> {
    await modal
        .locator('.checkbox-container', { hasText: 'I agree to the terms of service' })
        .click()
    await expect(modal.getByLabel('I agree to the terms of service')).toBeChecked()
}

const submit = (modal: Locator): Locator =>
    modal.getByRole('button', { name: 'Create Account', exact: true })

test.describe('register by e-mail', () => {
    test('the modal opens on the choice of e-mail or phone', async ({ page }) => {
        const modal = await openRegister(page)
        await expect(modal.getByRole('button', { name: 'Continue with phone' })).toBeVisible()
        await expect(
            modal.getByText('Choose the account creation path you want to use.'),
        ).toBeVisible()
    })

    test('strict answer (verify first): the server text is shown in the form-error slot, no sign-in', async ({
        page,
        api,
    }) => {
        // Recorded as it is: a success message without a user is rendered as an error block.
        await api.answer('auth/register/email', 200, STRICT_ANSWER)
        const modal = await openEmailForm(page)
        await fillEmailForm(modal, { name: '  Jane Doe ', email: ' jane@example.com ' })
        await submit(modal).click()

        await expect(formError(modal)).toHaveText(STRICT_ANSWER.message)
        await expect(page).not.toHaveURL(/\/account/)
        // Name and e-mail are trimmed; the password is sent as typed.
        expect(api.callsTo('auth/register/email')).toEqual([
            {
                method: 'POST',
                path: '/api/auth/register/email',
                body: {
                    name: 'Jane Doe',
                    email: 'jane@example.com',
                    password: 'correct-horse',
                    token: '',
                },
            },
        ])
    })

    test('non-strict answer (a user): signed in, the modal closes, the account page opens', async ({
        page,
        api,
    }) => {
        await api.answer('auth/register/email', 200, SIGNED_IN, {
            onRequest: () => {
                api.setSession(SIGNED_IN.user)
            },
        })
        api.ignoreOtherRequests()
        const modal = await openEmailForm(page)
        await fillEmailForm(modal)
        await submit(modal).click()

        await expect(page).toHaveURL(/\/account$/)
        await expect(page.locator('.modal-overlay.show')).toHaveCount(0)
    })

    test('a refused registration shows the server message and keeps the form', async ({
        page,
        api,
    }) => {
        await api.answer('auth/register/email', 400, {
            status: 'error',
            code: 'bad_request',
            message: 'Too many registration attempts. Please try again later.',
        })
        const modal = await openEmailForm(page)
        await fillEmailForm(modal)
        await submit(modal).click()

        await expect(formError(modal)).toHaveText(
            'Too many registration attempts. Please try again later.',
        )
        await expect(modal.locator('#register-email')).toHaveValue('jane@example.com')
        await expect(submit(modal)).toBeEnabled()
    })

    test('a 500 shows the server message', async ({ page, api }) => {
        await api.answer('auth/register/email', 500, {
            status: 'error',
            code: 'internal_error',
            message: 'Failed to create user',
        })
        const modal = await openEmailForm(page)
        await fillEmailForm(modal)
        await submit(modal).click()
        await expect(formError(modal)).toHaveText('Failed to create user')
    })

    test('a second click while the request is in flight sends nothing: one request', async ({
        page,
        api,
    }) => {
        await api.answer('auth/register/email', 200, STRICT_ANSWER, { delayMs: 600 })
        const modal = await openEmailForm(page)
        await fillEmailForm(modal)
        await submit(modal).click()
        await expect(submit(modal)).toBeDisabled()
        await clickWhereItIs(page, submit(modal))

        await expect(formError(modal)).toBeVisible()
        expect(api.callsTo('auth/register/email')).toHaveLength(1)
    })

    test.describe('client-side validation sends no request', () => {
        test('an empty form: every field and the terms', async ({ page, api }) => {
            const modal = await openEmailForm(page)
            await submit(modal).click()

            await expect(fieldError(modal, 'register-name')).toHaveText('Name is required')
            await expect(fieldError(modal, 'register-email')).toHaveText('Email is required')
            await expect(fieldError(modal, 'register-password')).toHaveText('Password is required')
            await expect(
                modal.getByText('You must accept the terms of service to create an account'),
            ).toBeVisible()
            expect(api.calls).toEqual([])
        })

        test('e-mail format, password length, confirmation, terms', async ({ page, api }) => {
            const modal = await openEmailForm(page)
            await fillEmailForm(modal, {
                email: 'jane@example',
                password: '1234567',
                confirm: '12345678',
                terms: false,
            })
            await submit(modal).click()

            await expect(fieldError(modal, 'register-email')).toHaveText('Enter a valid email')
            await expect(fieldError(modal, 'register-password')).toHaveText(
                'Password must be at least 8 characters long',
            )
            await expect(fieldError(modal, 'register-password-confirm')).toHaveText(
                'Passwords do not match',
            )
            await expect(
                modal.getByText('You must accept the terms of service to create an account'),
            ).toBeVisible()
            expect(api.calls).toEqual([])
        })

        test('everything right except the terms', async ({ page, api }) => {
            const modal = await openEmailForm(page)
            await fillEmailForm(modal, { terms: false })
            await submit(modal).click()
            await expect(
                modal.getByText('You must accept the terms of service to create an account'),
            ).toBeVisible()
            expect(api.calls).toEqual([])
        })
    })
})

test.describe('register by phone', () => {
    const START = 'auth/register/phone/start'
    const CONFIRM = 'auth/register/phone/confirm'
    const COMPLETE = 'auth/register/phone/complete-profile'
    const STARTED = {
        status: 'success',
        challengeId: 'ch-1',
        expiresAt: '2030-01-01T00:10:00.000Z',
        resendAvailableAt: '2030-01-01T00:01:00.000Z',
    }

    async function openPhoneStart(page: Page): Promise<Locator> {
        const modal = await openRegister(page)
        await modal.getByRole('button', { name: 'Continue with phone' }).click()
        await expect(modal.locator('#register-phone')).toBeVisible()
        return modal
    }

    async function toConfirm(page: Page, api: Api) {
        await api.answer(START, 200, STARTED)
        const modal = await openPhoneStart(page)
        await modal.locator('#register-phone').fill(' +15551234567 ')
        await modal.getByRole('button', { name: 'Send verification code' }).click()
        await expect(modal.locator('#register-phone-code')).toBeVisible()
        return modal
    }

    test('start: the number goes out trimmed, with an optional country, and the code step shows the challenge', async ({
        page,
        api,
    }) => {
        await api.answer(START, 200, STARTED)
        const modal = await openPhoneStart(page)
        await modal.locator('#register-phone').fill(' 5551234567 ')
        await modal.locator('#register-phone-country').fill('US')
        await modal.getByRole('button', { name: 'Send verification code' }).click()

        await expect(modal.locator('#register-phone-code')).toBeVisible()
        // The step prints the raw challenge id and the raw ISO times; there is no timer.
        await expect(modal.getByText('Challenge ID: ch-1')).toBeVisible()
        await expect(modal.getByText('Expires at: 2030-01-01T00:10:00.000Z')).toBeVisible()
        await expect(modal.getByText('Resend available at: 2030-01-01T00:01:00.000Z')).toBeVisible()
        expect(api.callsTo(START)).toEqual([
            {
                method: 'POST',
                path: `/api/${START}`,
                body: { phone: '5551234567', defaultCountry: 'US' },
            },
        ])
    })

    test('start without a country sends none', async ({ page, api }) => {
        await toConfirm(page, api)
        expect(api.callsTo(START)[0]?.body).toEqual({ phone: '+15551234567' })
    })

    test('start: a resend cooldown (429) shows the server message', async ({ page, api }) => {
        await api.answer(START, 429, {
            status: 'error',
            code: 'rate_limited',
            reason: 'resend_cooldown_active',
            message:
                'A verification code was already sent recently. Please wait before requesting another one.',
        })
        const modal = await openPhoneStart(page)
        await modal.locator('#register-phone').fill('+15551234567')
        await modal.getByRole('button', { name: 'Send verification code' }).click()

        await expect(formError(modal)).toHaveText(
            'A verification code was already sent recently. Please wait before requesting another one.',
        )
        await expect(modal.locator('#register-phone')).toBeVisible()
    })

    test('start: validation sends no request', async ({ page, api }) => {
        const modal = await openPhoneStart(page)
        await modal.getByRole('button', { name: 'Send verification code' }).click()
        await expect(fieldError(modal, 'register-phone')).toHaveText('Phone is required')

        await modal.locator('#register-phone').fill('abc')
        await modal.getByRole('button', { name: 'Send verification code' }).click()
        await expect(fieldError(modal, 'register-phone')).toHaveText('Enter a valid phone number')
        expect(api.calls).toEqual([])
    })

    test('confirm: a wrong code shows the server message and keeps the step', async ({
        page,
        api,
    }) => {
        const modal = await toConfirm(page, api)
        await api.answer(CONFIRM, 400, {
            status: 'error',
            code: 'bad_request',
            message: 'Invalid verification code',
        })
        await modal.locator('#register-phone-code').fill('000000')
        await modal.getByRole('button', { name: 'Verify code' }).click()

        await expect(formError(modal)).toHaveText('Invalid verification code')
        await expect(modal.locator('#register-phone-code')).toHaveValue('000000')
    })

    test('confirm: an empty code sends no request', async ({ page, api }) => {
        const modal = await toConfirm(page, api)
        await modal.getByRole('button', { name: 'Verify code' }).click()
        await expect(fieldError(modal, 'register-phone-code')).toHaveText(
            'Verification code is required',
        )
        expect(api.callsTo(CONFIRM)).toEqual([])
    })

    test('confirm: a second click while the request is in flight sends nothing: one request', async ({
        page,
        api,
    }) => {
        const modal = await toConfirm(page, api)
        await api.answer(CONFIRM, 200, { status: 'success' }, { delayMs: 600 })
        await modal.locator('#register-phone-code').fill('123456')
        await modal.getByRole('button', { name: 'Verify code' }).click()
        const busy = modal.getByRole('button', { name: 'Verifying code...' })
        await expect(busy).toBeDisabled()
        await clickWhereItIs(page, busy)

        await expect(modal.locator('#register-phone-name')).toBeVisible()
        expect(api.callsTo(CONFIRM)).toHaveLength(1)
    })

    test('the whole path: start, confirm, complete — signed in on the account page', async ({
        page,
        api,
    }) => {
        const modal = await toConfirm(page, api)
        await api.answer(CONFIRM, 200, { status: 'success' })
        await api.answer(COMPLETE, 200, SIGNED_IN, {
            onRequest: () => {
                api.setSession(SIGNED_IN.user)
            },
        })
        api.ignoreOtherRequests()

        await modal.locator('#register-phone-code').fill(' 123456 ')
        await modal.getByRole('button', { name: 'Verify code' }).click()
        await expect(modal.locator('#register-phone-name')).toBeVisible()

        await modal.locator('#register-phone-name').fill('Jane Doe')
        await modal.locator('#register-phone-password').fill('correct-horse')
        await modal.locator('#register-phone-password-confirm').fill('correct-horse')
        await acceptTerms(modal)
        await modal.getByRole('button', { name: 'Create Account', exact: true }).click()

        await expect(page).toHaveURL(/\/account$/)
        expect(api.callsTo(CONFIRM)[0]?.body).toEqual({ challengeId: 'ch-1', code: '123456' })
        expect(api.callsTo(COMPLETE)[0]?.body).toEqual({
            challengeId: 'ch-1',
            name: 'Jane Doe',
            password: 'correct-horse',
            token: '',
        })
    })

    test('complete: validation sends no request', async ({ page, api }) => {
        const modal = await toConfirm(page, api)
        await api.answer(CONFIRM, 200, { status: 'success' })
        await modal.locator('#register-phone-code').fill('123456')
        await modal.getByRole('button', { name: 'Verify code' }).click()
        await expect(modal.locator('#register-phone-name')).toBeVisible()

        await modal.locator('#register-phone-password').fill('1234567')
        await modal.locator('#register-phone-password-confirm').fill('different')
        await modal.getByRole('button', { name: 'Create Account', exact: true }).click()

        await expect(fieldError(modal, 'register-phone-name')).toHaveText('Name is required')
        await expect(fieldError(modal, 'register-phone-password')).toHaveText(
            'Password must be at least 8 characters long',
        )
        await expect(fieldError(modal, 'register-phone-password-confirm')).toHaveText(
            'Passwords do not match',
        )
        await expect(
            modal.getByText('You must accept the terms of service to create an account'),
        ).toBeVisible()
        expect(api.callsTo(COMPLETE)).toEqual([])
    })

    test('the back links walk the steps backwards', async ({ page, api }) => {
        const modal = await toConfirm(page, api)
        await modal.getByText('Back').click()
        await expect(modal.locator('#register-phone')).toBeVisible()
        await modal.getByText('Back').click()
        await expect(modal.getByRole('button', { name: 'Continue with email' })).toBeVisible()
    })
})
