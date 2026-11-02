import { expect, test } from './support.js'

// feat-083 (O): the interface speaks the languages that ship (en, uk, pl), by the language of the
// browser; any other language shows English, and nothing breaks on the way.

const cases = [
    { locale: 'uk-UA', signIn: 'Увійти', create: 'Створити акаунт', html: 'uk' },
    { locale: 'pl-PL', signIn: 'Zaloguj się', create: 'Utwórz konto', html: 'pl' },
    { locale: 'en-GB', signIn: 'Sign In', create: 'Create Account', html: 'en' },
    // Languages the app recognises (Support AI answers in them) but has no interface file for
    { locale: 'ru-RU', signIn: 'Sign In', create: 'Create Account', html: 'en' },
    { locale: 'de-DE', signIn: 'Sign In', create: 'Create Account', html: 'en' },
    { locale: 'ja-JP', signIn: 'Sign In', create: 'Create Account', html: 'en' },
    // A language nobody knows
    { locale: 'tlh', signIn: 'Sign In', create: 'Create Account', html: 'en' },
]

for (const { locale, signIn, create } of cases) {
    test.describe(`browser language ${locale}`, () => {
        test.use({ locale })

        test(`the login page says "${signIn}" and "${create}"`, async ({ page, api }) => {
            api.ignoreOtherRequests()
            const errors: string[] = []
            page.on('pageerror', (error) => errors.push(error.message))

            await page.goto('/')
            await expect(page.getByRole('button', { name: signIn }).first()).toBeVisible()
            await expect(page.getByRole('button', { name: create }).first()).toBeVisible()
            expect(errors).toEqual([])
        })
    })
}

test.describe('browser language uk-UA: the modal too', () => {
    test.use({ locale: 'uk-UA' })

    test('the sign-in modal is in Ukrainian, with its field errors', async ({ page, api }) => {
        api.ignoreOtherRequests()
        await page.goto('/')
        await page.getByRole('button', { name: 'Увійти' }).first().click()
        const modal = page.locator('.modal-overlay.show')
        await expect(modal.locator('#login-identifier')).toBeVisible()
        await expect(modal.getByText('Забули пароль?')).toBeVisible()
        await modal.getByRole('button', { name: 'Увійти' }).click()
        await expect(modal.getByText('Вкажіть пошту або телефон')).toBeVisible()
    })
})
