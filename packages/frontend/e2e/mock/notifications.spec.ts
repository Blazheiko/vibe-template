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
        await api.answer('notifications/preferences', 200, {
            status: 'success',
            preferences: MATRIX,
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
})
