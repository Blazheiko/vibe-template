import { expect, test } from './support.js'

// feat-236 T8: the notification center against faked answers. The signals over the socket and
// two browsers run against the real backend in e2e-live/notifications.spec.ts.

const USER = { id: '1', name: 'Jane', email: 'jane@example.com', role: 'user' }

const item = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: 'security.new_sign_in',
    category: 'security',
    params: { device: 'Firefox on Linux' },
    link: '/account#sessions',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    readAt: null,
    ...over,
})

const MATRIX = [
    { category: 'security', channel: 'push', enabled: true, locked: false },
    { category: 'security', channel: 'email', enabled: true, locked: true },
    { category: 'support', channel: 'push', enabled: true, locked: false },
]

test.describe('notification center', () => {
    test.use({ locale: 'en-GB' })

    test.beforeEach(async ({ api }) => {
        api.ignoreOtherRequests()
        api.setSession(USER)
        await api.answer('auth/sign-in-methods', 200, {
            status: 'success',
            hasPassword: true,
            methods: [],
        })
        // Registered first, so the more specific answers below take their paths.
        await api.answer('notifications**', 200, {
            status: 'success',
            items: [
                item('12'),
                item('7', {
                    kind: 'support.reply',
                    category: 'support',
                    params: {},
                    link: '/support',
                }),
            ],
            next: null,
            unreadCount: 2,
        })
        await api.answer('notifications/unread-count', 200, { status: 'success', unreadCount: 2 })
        await api.answer('notifications/preferences', 200, {
            status: 'success',
            preferences: MATRIX,
        })
    })

    test('the bell shows the unread count and the latest notifications', async ({ page }) => {
        await page.goto('/account')
        await expect(page.getByTestId('notification-badge')).toHaveText('2')

        await page.getByTestId('notification-bell').click()
        const panel = page.getByTestId('notification-panel')
        await expect(panel).toContainText('Signed in from Firefox on Linux.')
        await expect(panel).toContainText('Support replied')

        await page.keyboard.press('Escape')
        await expect(panel).toHaveCount(0)
    })

    test('"mark all as read" sends the newest id shown', async ({ page, api }) => {
        await api.answer('notifications/read-all', 200, { status: 'success', unreadCount: 0 })

        await page.goto('/account')
        await page.getByTestId('notification-bell').click()
        await page.getByTestId('notifications-mark-all').click()

        await expect(page.getByTestId('notification-badge')).toHaveCount(0)
        expect(api.callsTo('notifications/read-all')[0]).toMatchObject({
            method: 'POST',
            body: { upTo: '12' },
        })
    })

    test('opening a notification marks it read and goes to its link', async ({ page, api }) => {
        await api.answer('notifications/12/read', 200, {
            status: 'success',
            link: '/account#sessions',
            unreadCount: 1,
        })

        await page.goto('/notifications')
        await page.getByTestId('notification-12').click()

        await page.waitForURL((url) => url.pathname === '/account' && url.hash === '#sessions')
        expect(api.callsTo('notifications/12/read')).toHaveLength(1)
    })

    test('a notification that is gone: back to the history with a notice', async ({
        page,
        api,
    }) => {
        await api.answer('notifications/99/read', 404, {
            status: 'error',
            code: 'not_found',
            message: 'Notification not found',
        })

        await page.goto('/notifications/99/open')

        await page.waitForURL((url) => url.pathname === '/notifications')
        await expect(page.getByTestId('notifications-notice')).toHaveText(
            'This notification no longer exists',
        )
    })

    test('preferences: support push turns off, the security email is locked', async ({
        page,
        api,
    }) => {
        // The PUT is answered with the matrix after the change, as the server does: an answer
        // with the old matrix would tick the box again before the click is checked.
        const answer = { status: 'success', preferences: MATRIX }
        await api.answer('notifications/preferences', 200, answer, {
            onRequest: () => {
                if (api.calls.at(-1)?.method !== 'PUT') return
                answer.preferences = MATRIX.map((cell) =>
                    cell.category === 'support' && cell.channel === 'push'
                        ? { ...cell, enabled: false }
                        : cell,
                )
            },
        })
        await page.goto('/account')
        const preferences = page.getByTestId('notification-preferences')
        await expect(
            preferences.getByTestId('preference-security-email').locator('input'),
        ).toBeDisabled()
        await expect(preferences.getByTestId('preference-security-email')).toContainText(
            'Always on for security',
        )

        await preferences.getByTestId('preference-support-push').locator('input').uncheck()

        await expect
            .poll(() =>
                api.callsTo('notifications/preferences').filter((call) => call.method === 'PUT'),
            )
            .toHaveLength(1)
        expect(
            api.callsTo('notifications/preferences').find((call) => call.method === 'PUT'),
        ).toMatchObject({ body: { category: 'support', channel: 'push', enabled: false } })
    })

    // feat-237 (review of #732, 1): the history scrolls in its own container under the header.
    test.describe('on a phone', () => {
        test.use({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true })

        test('a long history scrolls down to "show more"', async ({ page, api }) => {
            const many = Array.from({ length: 20 }, (_, index) => item(String(100 - index)))
            await api.answer('notifications**', 200, {
                status: 'success',
                items: many,
                next: '81',
                unreadCount: 20,
            })

            await page.goto('/notifications')
            const more = page.getByTestId('notifications-more')
            await expect(more).toBeAttached()
            const scroller = page.getByTestId('notifications-scroll')
            expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)

            await page.getByTestId('notifications-list').hover()
            await page.mouse.wheel(0, 5000)
            await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
            await expect(more).toBeInViewport()
        })
    })

    // feat-237 (review of #732, 4): the bell panel has its own list.
    test('opening the bell keeps the "Unread" tab of the history', async ({ page }) => {
        await page.goto('/notifications')
        await page.getByTestId('notifications-tab-unread').click()
        await expect(page.getByTestId('notifications-tab-unread')).toHaveAttribute(
            'aria-selected',
            'true',
        )

        await page.getByTestId('notification-bell').click()
        await expect(page.getByTestId('notification-panel')).toBeVisible()

        await expect(page.getByTestId('notifications-tab-unread')).toHaveAttribute(
            'aria-selected',
            'true',
        )
    })

    // feat-238 (re-review of #736, 1): opening the bell keeps the pages the history loaded.
    test('opening the bell keeps the second page of the history', async ({ page }) => {
        await page.route('**/api/notifications?**', async (route) => {
            const url = new URL(route.request().url())
            const before = url.searchParams.get('before')
            const limit = url.searchParams.get('limit')
            const body =
                limit === '10'
                    ? { items: [item('12')], next: null }
                    : before === '12'
                      ? { items: [item('3', { params: { device: 'Safari on iOS' } })], next: null }
                      : { items: [item('12')], next: '12' }
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ status: 'success', unreadCount: 2, ...body }),
            })
        })

        await page.goto('/notifications')
        await page.getByTestId('notifications-more').click()
        const list = page.getByTestId('notifications-list')
        await expect(list.getByTestId('notification-3')).toBeVisible()

        await page.getByTestId('notification-bell').click()
        await expect(page.getByTestId('notification-panel')).toBeVisible()
        await page.waitForTimeout(600)

        await expect(list.getByTestId('notification-3')).toBeVisible()
        await expect(page.getByTestId('notifications-more')).toHaveCount(0)
    })
})
