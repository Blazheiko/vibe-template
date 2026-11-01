import {
    clickWhereItIs,
    expect,
    fieldError,
    formError,
    openLogin,
    SIGNED_IN,
    test,
} from './support.js'

// feat-069 (G2): the login modal on faked API answers. See support.ts.

test.describe('login modal', () => {
    test('a right password signs in: one request, the modal closes, the account page opens', async ({
        page,
        api,
    }) => {
        await api.answer('auth/login', 200, SIGNED_IN, {
            onRequest: () => {
                api.setSession(SIGNED_IN.user)
            },
        })
        // The account page asks for more once the user is in; those answers are not the point.
        api.ignoreOtherRequests()

        const modal = await openLogin(page)
        await modal.locator('#login-identifier').fill('  jane@example.com  ')
        await modal.locator('#login-password').fill('correct-horse')
        await modal.getByRole('button', { name: 'Sign In' }).click()

        await expect(page).toHaveURL(/\/account$/)
        await expect(page.locator('.modal-overlay.show')).toHaveCount(0)
        // The identifier is trimmed; the token of an invite is empty without one.
        expect(api.callsTo('auth/login')).toEqual([
            {
                method: 'POST',
                path: '/api/auth/login',
                body: { identifier: 'jane@example.com', password: 'correct-horse', token: '' },
            },
        ])
    })

    test('a phone number goes in the same field and the same request', async ({ page, api }) => {
        await api.answer('auth/login', 401, { status: 'error', code: 'unauthorized' })
        const modal = await openLogin(page)
        await modal.locator('#login-identifier').fill('+15551234567')
        await modal.locator('#login-password').fill('correct-horse')
        await modal.getByRole('button', { name: 'Sign In' }).click()

        await expect(formError(modal)).toBeVisible()
        expect(api.callsTo('auth/login')[0]?.body).toEqual({
            identifier: '+15551234567',
            password: 'correct-horse',
            token: '',
        })
    })

    test('a wrong password (401) shows the one invalid-credentials text and keeps the form', async ({
        page,
        api,
    }) => {
        await api.answer('auth/login', 401, {
            status: 'error',
            code: 'unauthorized',
            message: 'Invalid email or password',
        })
        const modal = await openLogin(page)
        await modal.locator('#login-identifier').fill('jane@example.com')
        await modal.locator('#login-password').fill('wrong-password')
        await modal.getByRole('button', { name: 'Sign In' }).click()

        await expect(formError(modal)).toHaveText(
            'Invalid login credentials. If you signed up with Google or Facebook, sign in with that button instead.',
        )
        await expect(page).not.toHaveURL(/\/account/)
        await expect(modal.locator('#login-identifier')).toHaveValue('jane@example.com')
        await expect(modal.locator('#login-password')).toHaveValue('wrong-password')
        await expect(modal.getByRole('button', { name: 'Sign In' })).toBeEnabled()
    })

    test('the 401 of a spent throttle reads exactly like a wrong password', async ({
        page,
        api,
    }) => {
        // The server answers a spent login counter with the same 401 (auth-service, `login`).
        await api.answer('auth/login', 401, {
            status: 'error',
            code: 'unauthorized',
            message: 'Invalid email or password',
        })
        const modal = await openLogin(page)
        await modal.locator('#login-identifier').fill('jane@example.com')
        await modal.locator('#login-password').fill('whatever-123')
        await modal.getByRole('button', { name: 'Sign In' }).click()
        const invalid =
            'Invalid login credentials. If you signed up with Google or Facebook, sign in with that button instead.'
        await expect(formError(modal)).toHaveText(invalid)

        await modal.getByRole('button', { name: 'Sign In' }).click()
        await expect.poll(() => api.callsTo('auth/login').length).toBe(2)
        await expect(formError(modal)).toHaveText(invalid)
    })

    test('a 429 from the route limiter shows the server message; the form stays usable', async ({
        page,
        api,
    }) => {
        // Recorded as it is: there is no 429-specific text on the login step (forgot password has
        // one) and no lock-out of the button beyond the request being in flight.
        await api.answer('auth/login', 429, {
            status: 'error',
            code: 'rate_limited',
            message: 'Too many requests',
        })
        const modal = await openLogin(page)
        await modal.locator('#login-identifier').fill('jane@example.com')
        await modal.locator('#login-password').fill('whatever-123')
        await modal.getByRole('button', { name: 'Sign In' }).click()

        await expect(formError(modal)).toHaveText('Too many requests')
        await expect(modal.getByRole('button', { name: 'Sign In' })).toBeEnabled()
    })

    test('a 500 shows the server message', async ({ page, api }) => {
        await api.answer('auth/login', 500, {
            status: 'error',
            code: 'internal_error',
            message: 'Failed to enforce login IP throttle',
        })
        const modal = await openLogin(page)
        await modal.locator('#login-identifier').fill('jane@example.com')
        await modal.locator('#login-password').fill('whatever-123')
        await modal.getByRole('button', { name: 'Sign In' }).click()

        await expect(formError(modal)).toHaveText('Failed to enforce login IP throttle')
    })

    test('a 503 shows the server message', async ({ page, api }) => {
        await api.answer('auth/login', 503, {
            status: 'error',
            code: 'service_unavailable',
            message: 'Service temporarily unavailable. Try again later.',
        })
        const modal = await openLogin(page)
        await modal.locator('#login-identifier').fill('jane@example.com')
        await modal.locator('#login-password').fill('whatever-123')
        await modal.getByRole('button', { name: 'Sign In' }).click()

        await expect(formError(modal)).toHaveText(
            'Service temporarily unavailable. Try again later.',
        )
    })

    test('a second click while the request is in flight sends nothing: one request', async ({
        page,
        api,
    }) => {
        await api.answer(
            'auth/login',
            401,
            { status: 'error', code: 'unauthorized' },
            { delayMs: 600 },
        )
        const modal = await openLogin(page)
        await modal.locator('#login-identifier').fill('jane@example.com')
        await modal.locator('#login-password').fill('whatever-123')

        const button = modal.getByRole('button', { name: 'Sign In' })
        await button.click()
        const busy = modal.getByRole('button', { name: 'Signing In...' })
        await expect(busy).toBeDisabled()
        // A real second click on the disabled button: the browser does not deliver it.
        await clickWhereItIs(page, busy)
        await clickWhereItIs(page, busy)

        await expect(formError(modal)).toBeVisible()
        expect(api.callsTo('auth/login')).toHaveLength(1)
        await expect(modal.getByRole('button', { name: 'Sign In' })).toBeEnabled()
    })

    test('Enter in a field does nothing: the step is not a <form>', async ({ page, api }) => {
        // Recorded as it is. J may turn the step into a form; then this row changes on purpose.
        await api.answer('auth/login', 401, { status: 'error', code: 'unauthorized' })
        const modal = await openLogin(page)
        await modal.locator('#login-identifier').fill('jane@example.com')
        await modal.locator('#login-password').fill('whatever-123')
        await modal.locator('#login-password').press('Enter')

        // A fixed wait is the point: nothing is to happen, so there is nothing to wait for.
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(300)
        expect(api.callsTo('auth/login')).toHaveLength(0)
    })

    test.describe('client-side validation sends no request', () => {
        const cases: readonly {
            name: string
            identifier: string
            password: string
            field: 'login-identifier' | 'login-password'
            message: string
        }[] = [
            {
                name: 'empty identifier',
                identifier: '',
                password: 'long-enough-1',
                field: 'login-identifier',
                message: 'Email or phone is required',
            },
            {
                name: 'neither an e-mail nor a phone number',
                identifier: 'not-an-address',
                password: 'long-enough-1',
                field: 'login-identifier',
                message: 'Enter a valid email address or phone number',
            },
            {
                name: 'e-mail without a domain',
                identifier: 'jane@example',
                password: 'long-enough-1',
                field: 'login-identifier',
                message: 'Enter a valid email address or phone number',
            },
            {
                name: 'empty password',
                identifier: 'jane@example.com',
                password: '',
                field: 'login-password',
                message: 'Password is required',
            },
            {
                name: 'password of 7 characters',
                identifier: 'jane@example.com',
                password: '1234567',
                field: 'login-password',
                message: 'Password must be at least 8 characters long',
            },
        ]

        for (const c of cases) {
            test(c.name, async ({ page, api }) => {
                const modal = await openLogin(page)
                await modal.locator('#login-identifier').fill(c.identifier)
                await modal.locator('#login-password').fill(c.password)
                await modal.getByRole('button', { name: 'Sign In' }).click()

                await expect(fieldError(modal, c.field)).toHaveText(c.message)
                expect(api.calls).toEqual([])
            })
        }

        test('the identifier is checked before the password: only its error shows', async ({
            page,
        }) => {
            const modal = await openLogin(page)
            await modal.locator('#login-identifier').fill('nope')
            await modal.locator('#login-password').fill('short')
            await modal.getByRole('button', { name: 'Sign In' }).click()

            await expect(fieldError(modal, 'login-identifier')).toBeVisible()
            await expect(fieldError(modal, 'login-password')).toHaveCount(0)
        })
    })
})
