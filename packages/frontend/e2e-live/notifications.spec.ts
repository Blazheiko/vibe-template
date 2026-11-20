import type { APIRequestContext, Page } from '@playwright/test'

import { createVerifiedAccount, expect, loginInUi, newBrowser, test } from './support'
import type { Account } from './support'

// feat-236 T8 (Р7, Р8, Р11): the notification center against the real backend. Every sign-in is
// stored as `security.new_sign_in` and signalled to the account's open browsers.

const badge = (page: Page) => page.getByTestId('notification-badge')

interface NotificationsPage {
    items: { id: string; kind: string; readAt: string | null }[]
    unreadCount: number
}

const listOf = async (request: APIRequestContext): Promise<NotificationsPage> => {
    const response = await request.get('/api/notifications')
    expect(response.status()).toBe(200)
    return (await response.json()) as NotificationsPage
}

async function signInElsewhere(browser: Parameters<typeof newBrowser>[0], account: Account) {
    const other = await newBrowser(browser)
    await loginInUi(other.page, account)
    await other.context.close()
}

test('a sign-in elsewhere shows up in both open browsers; reading it in one clears the other', async ({
    browser,
    sink,
}) => {
    const account = await createVerifiedAccount(browser, sink)
    const a = await newBrowser(browser)
    const b = await newBrowser(browser)
    await loginInUi(a.page, account)
    await loginInUi(b.page, account)
    // The sign-ins of a and b themselves are notifications too: read them all first.
    const before = await listOf(a.context.request)
    expect(before.items.every((item) => item.kind === 'security.new_sign_in')).toBe(true)
    await a.page.getByTestId('notification-bell').click()
    await a.page.getByTestId('notifications-mark-all').click()
    await expect(badge(a.page)).toHaveCount(0)
    await a.page.keyboard.press('Escape')
    await expect(a.page.getByTestId('notification-panel')).toHaveCount(0)
    await expect(badge(b.page)).toHaveCount(0)

    await signInElsewhere(browser, account)

    // No reload: the signal reaches both sockets and they read the count again.
    await expect(badge(a.page)).toHaveText('1')
    await expect(badge(b.page)).toHaveText('1')

    // a opens it from its panel: it lands on the session list and the count goes in b too.
    await a.page.getByTestId('notification-bell').click()
    await a.page.getByTestId('notification-panel').locator('[data-unread="true"]').first().click()
    await a.page.waitForURL((url) => url.pathname === '/account' && url.hash === '#sessions')
    await expect(a.page.getByTestId('active-sessions')).toBeInViewport()
    await expect(badge(a.page)).toHaveCount(0)
    await expect(badge(b.page)).toHaveCount(0)

    await a.context.close()
    await b.context.close()
})

test('a signal missed while offline is caught up after the socket reconnects', async ({
    browser,
    sink,
}) => {
    const account = await createVerifiedAccount(browser, sink)
    const b = await newBrowser(browser)
    await loginInUi(b.page, account)
    await b.page.goto('/notifications')
    // b's own sign-in is the first notification; wait until the list has it.
    const rows = b.page.locator('[data-testid^="notification-"][data-unread]')
    await expect(rows).toHaveCount(1)
    await b.context.setOffline(true)
    await signInElsewhere(browser, account)
    await b.context.setOffline(false)

    // The reconnect sends ws_ready: badge and open list are read again.
    await expect(rows).toHaveCount(2, { timeout: 20_000 })
    await expect(badge(b.page)).toHaveText('2')

    await b.context.close()
})

test('opening a notification link without a session: sign in, then it opens on the section', async ({
    browser,
    sink,
}) => {
    const account = await createVerifiedAccount(browser, sink)
    const a = await newBrowser(browser)
    await loginInUi(a.page, account)
    const latest = (await listOf(a.context.request)).items.at(0)
    if (latest === undefined) throw new Error('no notification after a sign-in')
    expect(latest.readAt).toBeNull()

    // As a push opens it in a browser that has no session.
    const visitor = await newBrowser(browser)
    await visitor.page.goto(`/notifications/${latest.id}/open`)
    await visitor.page.waitForURL(/\/login\?redirect=/)
    await visitor.page.locator('#login-identifier').fill(account.email)
    await visitor.page.locator('#login-password').fill(account.password)
    await visitor.page
        .locator('button.auth-button', {
            has: visitor.page.locator('span', { hasText: 'Sign In' }),
        })
        .click()

    await visitor.page.waitForURL((url) => url.pathname === '/account' && url.hash === '#sessions')
    await expect(visitor.page.getByTestId('active-sessions')).toBeInViewport()
    const after = await listOf(a.context.request)
    expect(after.items.find((item) => item.id === latest.id)?.readAt).not.toBeNull()

    await a.context.close()
    await visitor.context.close()
})
