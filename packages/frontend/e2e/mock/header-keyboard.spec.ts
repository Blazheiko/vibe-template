import type { Page } from '@playwright/test'

import { expect, test, type Api } from './support.js'

// feat-279: the header and its menu by keyboard and by accessible name, on a phone, against
// faked answers.

const USER = { id: '1', name: 'Jane', email: 'jane@example.com', role: 'user' }

async function signedInOnNotifications(page: Page, api: Api): Promise<void> {
    api.ignoreOtherRequests()
    api.setSession(USER)
    await api.answer('notifications**', 200, {
        status: 'success',
        items: [],
        next: null,
        unreadCount: 0,
    })
    await api.answer('notifications/unread-count', 200, { status: 'success', unreadCount: 0 })
    await page.goto('/notifications')
}

test.describe('header by keyboard', () => {
    test.use({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true })

    test.describe('in English', () => {
        test.use({ locale: 'en-GB' })

        test('the hamburger and Back have names even where the Back text is hidden', async ({
            page,
            api,
        }) => {
            await signedInOnNotifications(page, api)
            const back = page.getByRole('button', { name: 'Back', exact: true })
            await expect(back).toBeVisible()
            await expect(back.locator('span')).toBeHidden()

            const menu = page.getByRole('button', { name: 'Open menu' })
            await expect(menu).toHaveAttribute('aria-expanded', 'false')
            await expect(menu).toHaveAttribute('aria-haspopup', 'true')
        })

        test('Escape closes the menu and puts the focus back on the hamburger', async ({
            page,
            api,
        }) => {
            await signedInOnNotifications(page, api)
            await page.getByRole('button', { name: 'Open menu' }).click()
            const close = page.getByRole('button', { name: 'Close menu' })
            await expect(close).toHaveAttribute('aria-expanded', 'true')
            // The first item of the opened menu has the focus.
            await expect(page.getByRole('button', { name: 'Navigation' })).toBeFocused()

            await page.keyboard.press('Escape')

            const open = page.getByRole('button', { name: 'Open menu' })
            await expect(open).toBeFocused()
            await expect(open).toHaveAttribute('aria-expanded', 'false')
            await expect(page.locator('.dropdown-menu')).not.toHaveClass(/show/)
        })

        test('Tab skips the collapsed sections and reaches them once expanded', async ({
            page,
            api,
        }) => {
            await signedInOnNotifications(page, api)
            await page.getByRole('button', { name: 'Open menu' }).click()
            const navigation = page.getByRole('button', { name: 'Navigation' })
            const legal = page.getByRole('button', { name: 'Legal & Support' })
            await expect(navigation).toHaveAttribute('aria-expanded', 'true')
            await expect(legal).toHaveAttribute('aria-expanded', 'false')
            // Opening the menu moves the focus to its first item; wait, then move it ourselves.
            await expect(navigation).toBeFocused()

            // From the Legal header, Tab goes past its hidden items straight to Logout.
            await legal.focus()
            await page.keyboard.press('Tab')
            await expect(page.getByRole('button', { name: 'Logout' })).toBeFocused()

            await legal.press('Enter')
            await expect(legal).toHaveAttribute('aria-expanded', 'true')
            await legal.focus()
            await page.keyboard.press('Tab')
            await expect(page.getByRole('button', { name: 'Support' }).last()).toBeFocused()
        })
    })

    test.describe('in Ukrainian', () => {
        test.use({ locale: 'uk-UA' })

        test('the header and the menu are translated', async ({ page, api }) => {
            await api.answer('profile/preferences', 200, { status: 'success' })
            await signedInOnNotifications(page, api)
            await expect(page.getByRole('button', { name: 'Назад', exact: true })).toBeVisible()
            await page.getByRole('button', { name: 'Відкрити меню' }).click()
            await expect(page.getByRole('button', { name: 'Навігація' })).toBeVisible()
            await expect(page.getByRole('button', { name: 'Вийти' })).toBeVisible()
            await expect(page.locator('.websocket-status')).toHaveAttribute(
                'title',
                /^Стан WebSocket: /,
            )
        })
    })
})
