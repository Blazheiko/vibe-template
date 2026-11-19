import type { Page } from '@playwright/test'

import { USER_1, USER_2 } from './fixtures'
import { expect, loginInUi, newBrowser, session, test } from './support'

// feat-232 T14: the profile and its preferences against the real backend. The seeded accounts
// live on between runs (one database), so every test starts by resetting the profiles it uses.

const NAME_1 = 'Live User One'
const NAME_2 = 'Live User Two'
const NO_PREFERENCES = {
    locale: null,
    timeZone: null,
    theme: null,
    colorTheme: null,
    fontSize: null,
}

async function patchProfile(page: Page, body: Record<string, unknown>): Promise<void> {
    const api = session(page.context().request)
    const token = await api.token()
    const response = await page.context().request.patch('/api/account/profile', {
        data: body,
        headers: { origin: new URL(page.url()).origin, 'x-csrf-token': token },
    })
    expect(response.status(), await response.text()).toBe(200)
}

/** Signs in, resets the profile to a known state and reloads, so the page shows it. */
async function signInClean(page: Page, account: typeof USER_1, name: string): Promise<void> {
    await loginInUi(page, account)
    await patchProfile(page, { name, ...NO_PREFERENCES })
    await page.reload()
    await expect(page.locator('.profile-copy h1')).toHaveText(name)
}

async function logoutInUi(page: Page): Promise<void> {
    await page.locator('button.menu-button').click()
    await page.locator('button.logout-item').click()
    await page.waitForURL('**/login')
}

const form = (page: Page) => page.getByTestId('profile-form')
const settings = (page: Page) => page.getByTestId('preferences')

async function saveProfileForm(
    page: Page,
    values: { name?: string; locale?: string; timeZone?: string },
): Promise<void> {
    if (values.name !== undefined) {
        await form(page).locator('input[name="profile-name"]').fill(values.name)
    }
    if (values.locale !== undefined) {
        await form(page).locator('select[name="profile-locale"]').selectOption(values.locale)
    }
    if (values.timeZone !== undefined) {
        await form(page).locator('select[name="profile-time-zone"]').selectOption(values.timeZone)
    }
    const saved = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === '/api/account/profile' &&
            response.request().method() === 'PATCH',
    )
    await form(page).locator('button[type="submit"]').click()
    expect((await saved).status()).toBe(200)
}

async function chooseTheme(page: Page, value: 'system' | 'light' | 'dark'): Promise<void> {
    const saved = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === '/api/account/profile' &&
            response.request().method() === 'PATCH',
    )
    await settings(page).locator(`input[name="theme"][value="${value}"]`).check()
    expect((await saved).status()).toBe(200)
}

const isDark = (page: Page) =>
    page.evaluate(() => document.documentElement.classList.contains('dark-theme'))

test('name, language, zone and theme survive a reload and show in a second browser', async ({
    browser,
}) => {
    const a = await newBrowser(browser)
    await a.page.emulateMedia({ colorScheme: 'light' })
    await signInClean(a.page, USER_1, NAME_1)

    await saveProfileForm(a.page, {
        name: 'Renamed Live User',
        locale: 'uk',
        timeZone: 'America/New_York',
    })
    await expect(a.page.getByRole('heading', { name: 'Профіль' })).toBeVisible()
    await chooseTheme(a.page, 'dark')
    expect(await isDark(a.page)).toBe(true)

    await a.page.reload()
    await expect(a.page.locator('.profile-copy h1')).toHaveText('Renamed Live User')
    await expect(a.page.getByRole('heading', { name: 'Профіль' })).toBeVisible()
    await expect(form(a.page).locator('select[name="profile-time-zone"]')).toHaveValue(
        'America/New_York',
    )
    expect(await isDark(a.page)).toBe(true)

    // Another device of the same account: the same look and language after sign-in.
    const b = await newBrowser(browser)
    await b.page.emulateMedia({ colorScheme: 'light' })
    await loginInUi(b.page, USER_1)
    await expect(b.page.locator('.profile-copy h1')).toHaveText('Renamed Live User')
    await expect(b.page.getByRole('heading', { name: 'Профіль' })).toBeVisible()
    await expect(form(b.page).locator('select[name="profile-time-zone"]')).toHaveValue(
        'America/New_York',
    )
    expect(await isDark(b.page)).toBe(true)

    await a.context.close()
    await b.context.close()
})

test('"Same as the system" follows the system theme after a reload', async ({ browser }) => {
    const a = await newBrowser(browser)
    await a.page.emulateMedia({ colorScheme: 'light' })
    await signInClean(a.page, USER_1, NAME_1)
    await chooseTheme(a.page, 'light')

    await a.page.emulateMedia({ colorScheme: 'dark' })
    // An explicit light stays light when the system turns dark (Р13).
    expect(await isDark(a.page)).toBe(false)

    await chooseTheme(a.page, 'system')
    expect(await isDark(a.page)).toBe(true)
    await a.page.reload()
    await expect(a.page.locator('.profile-copy h1')).toHaveText(NAME_1)
    expect(await isDark(a.page)).toBe(true)
    await a.page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => isDark(a.page)).toBe(false)

    await a.context.close()
})

test('signing out and in as another user shows none of the previous look', async ({ browser }) => {
    const a = await newBrowser(browser)
    await a.page.emulateMedia({ colorScheme: 'light' })
    // The second account first, so its profile is clean too.
    await signInClean(a.page, USER_2, NAME_2)
    await logoutInUi(a.page)

    await signInClean(a.page, USER_1, NAME_1)
    await chooseTheme(a.page, 'dark')
    const color = a.page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/account/profile',
    )
    await settings(a.page).locator('[data-color-theme="mint"]').click()
    await color
    await expect(a.page.locator('html')).toHaveAttribute('data-theme', 'mint')

    await logoutInUi(a.page)
    await loginInUi(a.page, USER_2)
    await expect(a.page.locator('.profile-copy h1')).toHaveText(NAME_2)
    await expect(a.page.locator('html')).toHaveAttribute('data-theme', 'rose')
    expect(await isDark(a.page)).toBe(false)

    await a.page.reload()
    await expect(a.page.locator('html')).toHaveAttribute('data-theme', 'rose')
    expect(await isDark(a.page)).toBe(false)

    await a.context.close()
})

test('a name with markup is text in the account header and in the admin list and card', async ({
    browser,
}) => {
    const markup = '<img src=x onerror=alert(1)>'
    const dialogs: string[] = []

    const user = await newBrowser(browser)
    user.page.on('dialog', (dialog) => {
        dialogs.push(dialog.message())
        void dialog.dismiss()
    })
    await signInClean(user.page, USER_1, NAME_1)
    await saveProfileForm(user.page, { name: markup })
    await expect(user.page.locator('.profile-copy h1')).toHaveText(markup)
    expect(await user.page.locator('.profile-copy h1 img').count()).toBe(0)

    const admin = await newBrowser(browser)
    admin.page.on('dialog', (dialog) => {
        dialogs.push(dialog.message())
        void dialog.dismiss()
    })
    await loginInUi(admin.page, USER_2)
    await admin.page.goto('/admin/users')
    const row = admin.page.locator('tr', { hasText: USER_1.email })
    await expect(row).toContainText(markup)
    expect(await admin.page.locator('img[src="x"]').count()).toBe(0)

    await row.click()
    const card = admin.page.locator('.online-modal')
    await expect(card).toContainText(markup)
    expect(await admin.page.locator('img[src="x"]').count()).toBe(0)
    expect(dialogs).toEqual([])

    // Leave the seeded account as the other specs expect it.
    await patchProfile(user.page, { name: NAME_1 })
    await user.context.close()
    await admin.context.close()
})

test('a change shows in another tab of the session and in another browser without a reload', async ({
    browser,
}) => {
    const a = await newBrowser(browser)
    await a.page.emulateMedia({ colorScheme: 'light' })
    await signInClean(a.page, USER_1, NAME_1)
    // A second tab of the same session: same cookies, its own socket.
    const tab = await a.context.newPage()
    await tab.emulateMedia({ colorScheme: 'light' })
    await tab.goto('/account')
    await expect(tab.locator('.profile-copy h1')).toHaveText(NAME_1)

    const b = await newBrowser(browser)
    await b.page.emulateMedia({ colorScheme: 'light' })
    await loginInUi(b.page, USER_1)
    // Both sockets are open before the change: events are not replayed.
    for (const page of [a.page, tab, b.page]) {
        await expect(page.locator('.websocket-status .status-text')).toHaveText('Connected')
    }
    expect(await isDark(tab)).toBe(false)
    expect(await isDark(b.page)).toBe(false)

    await chooseTheme(a.page, 'dark')
    await saveProfileForm(a.page, { name: 'Live Synced Name' })

    for (const page of [tab, b.page]) {
        await expect.poll(() => isDark(page)).toBe(true)
        await expect(page.locator('.profile-copy h1')).toHaveText('Live Synced Name')
    }

    await patchProfile(a.page, { name: NAME_1 })
    await a.context.close()
    await b.context.close()
})
