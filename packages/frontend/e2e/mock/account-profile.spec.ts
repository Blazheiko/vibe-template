import { expect, NO_PREFERENCES, test } from './support.js'

// feat-232 T13: the profile form of the account page against faked answers. The real backend
// runs the same flows in e2e-live/account-profile.spec.ts.

const USER = { id: '1', name: 'Jane', email: 'jane@example.com', role: 'user' }

const profile = (fields: Record<string, unknown>, revision: string) => ({
    status: 'success',
    profile: {
        name: 'Jane',
        preferences: { ...NO_PREFERENCES },
        revision,
        ...fields,
    },
})

test.describe('account profile form', () => {
    test.use({ locale: 'en-GB' })

    test.beforeEach(async ({ api }) => {
        api.ignoreOtherRequests()
        api.setSession(USER)
        // The account page lists the linked sign-in methods; none here.
        await api.answer('auth/sign-in-methods', 200, {
            status: 'success',
            hasPassword: true,
            methods: [],
        })
    })

    test('changes the name and the language; the page switches to the new language', async ({
        page,
        api,
    }) => {
        await api.answer(
            'account/profile',
            200,
            profile({ name: 'Ann', preferences: { ...NO_PREFERENCES, locale: 'uk' } }, '1'),
        )

        await page.goto('/account')
        const form = page.getByTestId('profile-form')
        await expect(form.locator('input[name="profile-name"]')).toHaveValue('Jane')

        await form.locator('input[name="profile-name"]').fill('  Ann ')
        await form.locator('select[name="profile-locale"]').selectOption('uk')
        await form.getByRole('button', { name: 'Save profile' }).click()

        await expect(page.getByRole('heading', { name: 'Профіль' })).toBeVisible()
        await expect(page.locator('.profile-copy h1')).toHaveText('Ann')
        await expect(page.locator('html')).toHaveAttribute('lang', 'uk')
        const patches = api.callsTo('account/profile')
        expect(patches).toHaveLength(1)
        expect(patches[0]).toMatchObject({ method: 'PATCH', body: { name: 'Ann', locale: 'uk' } })
    })

    test('shows the validation error of the name next to the field', async ({ page, api }) => {
        await api.answer('account/profile', 422, {
            status: 'error',
            code: 'validation_failed',
            message: 'Validation failed',
            details: {
                kind: 'validation',
                messages: ['name must be at most 100 characters'],
            },
        })

        await page.goto('/account')
        const form = page.getByTestId('profile-form')
        await form.locator('input[name="profile-name"]').fill('Somebody else')
        await form.getByRole('button', { name: 'Save profile' }).click()

        await expect(form.getByTestId('profile-name-error')).toHaveText(
            'name must be at most 100 characters',
        )
        await expect(page.locator('.profile-copy h1')).toHaveText('Jane')
    })

    test('a theme choice is saved through the profile and "Same as the system" sends null', async ({
        page,
        api,
    }) => {
        // Each save is answered with the state after it, as the server does: an answer with the
        // previous theme would put the radio back before the click is checked.
        const answer = profile({ preferences: { ...NO_PREFERENCES, theme: 'dark' } }, '1')
        await api.answer('account/profile', 200, answer, {
            onRequest: () => {
                const saves = api.callsTo('account/profile').filter((c) => c.method === 'PATCH')
                if (saves.length < 2) return
                answer.profile = {
                    ...answer.profile,
                    preferences: { ...NO_PREFERENCES, theme: null },
                    revision: '2',
                }
            },
        })

        await page.goto('/account')
        const panel = page.getByTestId('preferences')
        await panel.getByLabel('Dark').check()
        await expect(page.locator('html')).toHaveClass(/dark-theme/)
        await expect.poll(() => api.callsTo('account/profile').length).toBe(1)

        await panel.getByLabel('Same as the system').check()
        await expect.poll(() => api.callsTo('account/profile').length).toBe(2)
        expect(api.callsTo('account/profile').map((call) => call.body)).toEqual([
            { theme: 'dark' },
            { theme: null },
        ])
    })
})
