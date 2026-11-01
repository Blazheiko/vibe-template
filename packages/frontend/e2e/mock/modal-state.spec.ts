import { expect, loginModal, openLogin, openRegister, registerModal, test } from './support.js'

// feat-069 (G2): what the auth modals remember. Recorded as it is today, so that the split of
// AuthModals.vue (J) keeps it. See support.ts.

test.describe('opening and closing', () => {
    test('the login modal opens on /login and closing it goes back to /', async ({ page }) => {
        const modal = await openLogin(page)
        await expect(page).toHaveURL(/\/login$/)
        await expect(modal).toHaveClass(/\bshow\b/)

        await modal.getByRole('button', { name: 'Close modal' }).click()
        await expect(page.locator('.modal-overlay.show')).toHaveCount(0)
        await expect(page).toHaveURL(/localhost:\d+\/$/)
    })

    test('the register modal opens on /register and closing it goes back to /', async ({
        page,
    }) => {
        const modal = await openRegister(page)
        await expect(page).toHaveURL(/\/register$/)
        await expect(modal).toHaveClass(/\bshow\b/)

        await modal.getByRole('button', { name: 'Close modal' }).click()
        await expect(page.locator('.modal-overlay.show')).toHaveCount(0)
        await expect(page).toHaveURL(/localhost:\d+\/$/)
    })

    test('only one of the two modals is shown at a time', async ({ page }) => {
        const modal = await openLogin(page)
        await expect(modal).toHaveClass(/\bshow\b/)
        await expect(registerModal(page)).not.toHaveClass(/\bshow\b/)
    })
})

test.describe('state is reset on reopening', () => {
    test('login: typed values and an error are gone after close and open', async ({ page }) => {
        const modal = await openLogin(page)
        await modal.locator('#login-identifier').fill('jane@example.com')
        await modal.locator('#login-password').fill('x')
        await modal.getByRole('button', { name: 'Sign In' }).click()
        await expect(modal.locator('#login-password ~ .error-message')).toBeVisible()

        await modal.getByRole('button', { name: 'Close modal' }).click()
        await expect(page.locator('.modal-overlay.show')).toHaveCount(0)
        await page.getByRole('button', { name: 'Sign In' }).first().click()

        await expect(modal.locator('#login-identifier')).toHaveValue('')
        await expect(modal.locator('#login-password')).toHaveValue('')
        await expect(modal.locator('.error-message')).toHaveCount(0)
    })

    test('login: closing on the forgot-password step reopens on the sign-in step', async ({
        page,
    }) => {
        const modal = await openLogin(page)
        await modal.getByText('Forgot password?').click()
        await expect(modal.locator('#forgot-identifier')).toBeVisible()

        await modal.getByRole('button', { name: 'Close modal' }).click()
        await page.getByRole('button', { name: 'Sign In' }).first().click()
        await expect(modal.locator('#login-identifier')).toBeVisible()
        await expect(modal.locator('#forgot-identifier')).toHaveCount(0)
    })

    test('register: closing in the middle of the e-mail form reopens on the choice step, empty', async ({
        page,
    }) => {
        const modal = await openRegister(page)
        await modal.getByRole('button', { name: 'Continue with email' }).click()
        await modal.locator('#register-name').fill('Jane')
        await modal
            .locator('.checkbox-container', { hasText: 'I agree to the terms of service' })
            .click()

        await modal.getByRole('button', { name: 'Close modal' }).click()
        await expect(page.locator('.modal-overlay.show')).toHaveCount(0)
        await page.getByRole('button', { name: 'Create Account' }).first().click()

        await expect(modal.getByRole('button', { name: 'Continue with email' })).toBeVisible()
        await modal.getByRole('button', { name: 'Continue with email' }).click()
        await expect(modal.locator('#register-name')).toHaveValue('')
        await expect(modal.getByLabel('I agree to the terms of service')).not.toBeChecked()
    })
})

test.describe('switching between the modals', () => {
    test('"Register" in the login modal opens the register modal on its choice step', async ({
        page,
    }) => {
        const login = await openLogin(page)
        await login.getByRole('link', { name: 'Register' }).click()

        const register = registerModal(page)
        await expect(register).toHaveClass(/\bshow\b/)
        await expect(login).not.toHaveClass(/\bshow\b/)
        await expect(register.getByRole('button', { name: 'Continue with email' })).toBeVisible()
        await expect(page).toHaveURL(/\/register$/)
    })

    test('"Sign In" in the register modal opens the login modal', async ({ page }) => {
        const register = await openRegister(page)
        await register.getByRole('link', { name: 'Sign In' }).click()

        const login = loginModal(page)
        await expect(login).toHaveClass(/\bshow\b/)
        await expect(register).not.toHaveClass(/\bshow\b/)
        await expect(page).toHaveURL(/\/login$/)
    })

    test('what was typed on one side is gone when coming back', async ({ page }) => {
        const login = await openLogin(page)
        await login.locator('#login-identifier').fill('jane@example.com')
        await login.getByRole('link', { name: 'Register' }).click()

        const register = registerModal(page)
        await register.getByRole('button', { name: 'Continue with email' }).click()
        await register.locator('#register-name').fill('Jane')
        await register.getByRole('link', { name: 'Sign In' }).click()

        await expect(login.locator('#login-identifier')).toHaveValue('')
        await login.getByRole('link', { name: 'Register' }).click()
        await register.getByRole('button', { name: 'Continue with email' }).click()
        await expect(register.locator('#register-name')).toHaveValue('')
    })
})
