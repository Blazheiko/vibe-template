import { expect, test } from '@playwright/test'
import { loadLandingUrls } from '../build/load-urls'

// The same addresses the build used (vite.config.ts): the buttons must lead to the app.
const { appUrl, siteUrl } = loadLandingUrls()

const PAGES = [
    { path: '/', lang: 'en', register: 'Sign up', login: 'Log in' },
    { path: '/uk/', lang: 'uk', register: 'Зареєструватися', login: 'Увійти' },
    { path: '/pl/', lang: 'pl', register: 'Zarejestruj się', login: 'Zaloguj się' },
] as const

test.beforeEach(async ({ page }) => {
    // The app is not running: answer its pages so a click can be followed to its address.
    await page.route(`${appUrl}/**`, (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>app</h1>' }),
    )
})

for (const { path, lang, register, login } of PAGES) {
    test.describe(`page ${path}`, () => {
        test('renders in its language without console errors', async ({ page }) => {
            const errors: string[] = []
            page.on('console', (message) => {
                if (message.type() === 'error') errors.push(message.text())
            })
            page.on('pageerror', (error) => errors.push(error.message))
            const response = await page.goto(path)
            expect(response?.status()).toBe(200)
            await expect(page.locator('html')).toHaveAttribute('lang', lang)
            await expect(page.locator('h1')).toHaveCount(1)
            await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
                'href',
                `${siteUrl}${path}`,
            )
            expect(errors).toEqual([])
        })

        test('sign up leads to the app registration', async ({ page }) => {
            await page.goto(path)
            await page.getByRole('link', { name: register }).first().click()
            await expect(page).toHaveURL(`${appUrl}/register`)
        })

        test('log in leads to the app sign-in', async ({ page }) => {
            await page.goto(path)
            await page.getByRole('link', { name: login }).first().click()
            await expect(page).toHaveURL(`${appUrl}/login`)
        })
    })
}

test('the switcher moves between the locale pages', async ({ page }) => {
    await page.goto('/')
    await page.locator('.site-header').getByRole('link', { name: 'Українська' }).click()
    await expect(page).toHaveURL('/uk/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'uk')
    await page.locator('.site-header').getByRole('link', { name: 'Polski' }).click()
    await expect(page).toHaveURL('/pl/')
})

test('the page fits a phone screen without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 })
    await page.goto('/uk/')
    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
})

test('an unknown path is a 404, not the page', async ({ request }) => {
    // vite preview (appType 'mpa') answers 404 with an empty body; the 404.html page itself is
    // served by nginx and checked by scripts/verify-landing-deploy.sh.
    const response = await request.get('/no-such-page')
    expect(response.status()).toBe(404)
})
