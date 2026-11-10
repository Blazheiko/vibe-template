import type { BrowserContext, Page } from '@playwright/test'

import { createVerifiedAccount, expect, loginInUi, newBrowser, session, test } from './support'
import type { Account } from './support'

// feat-148 (review 2026-11-10, M9): two accounts in one browser. The browser keeps its push
// subscription across sign-outs, and the server sends to whoever owns the record, so the two
// have to stay in step. Backend, PostgreSQL and Redis are real; only the browser's PushManager
// is replaced (a headless browser has no push service to subscribe to), and it keeps its
// subscription in localStorage, as a browser keeps one across page loads.

const FAKE_PUSH_KEY = 'e2e-fake-push-endpoint'

/** Replaces PushManager in every page of the context. Runs in the page, before the app. */
function fakePushManager(storageKey: string): void {
    const fake = (endpoint: string) => ({
        endpoint,
        getKey: () => new Uint8Array([1, 2, 3, 4]).buffer,
        unsubscribe: () => {
            localStorage.removeItem(storageKey)
            return Promise.resolve(true)
        },
    })
    PushManager.prototype.getSubscription = function () {
        const endpoint = localStorage.getItem(storageKey)
        return Promise.resolve(
            endpoint === null ? null : (fake(endpoint) as unknown as PushSubscription),
        )
    }
    PushManager.prototype.subscribe = function () {
        // An allowed push host (PUSH_ALLOWED_ENDPOINT_HOSTS); nothing is ever sent to it.
        const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${crypto.randomUUID()}`
        localStorage.setItem(storageKey, endpoint)
        return Promise.resolve(fake(endpoint) as unknown as PushSubscription)
    }
}

async function sharedBrowser(
    browser: Parameters<typeof newBrowser>[0],
): Promise<{ context: BrowserContext; page: Page }> {
    const shared = await newBrowser(browser)
    await shared.context.grantPermissions(['notifications'])
    await shared.context.addInitScript(fakePushManager, FAKE_PUSH_KEY)
    return shared
}

const browserEndpoint = (page: Page): Promise<string | null> =>
    page.evaluate((key) => localStorage.getItem(key), FAKE_PUSH_KEY)

const pushToggle = (page: Page) =>
    page.locator('label.setting-row', { hasText: 'Enable push notifications' }).locator('input')

/** The subscriptions the server holds for whoever is signed in in this context. */
async function serverSubscriptions(
    context: BrowserContext,
): Promise<{ endpoint: string; isActive: boolean; notificationLogs: unknown[] }[]> {
    const response = await context.request.get('/api/push-subscriptions')
    expect(response.status()).toBe(200)
    const body = (await response.json()) as {
        subscriptions: { endpoint: string; isActive: boolean; notificationLogs: unknown[] }[]
    }
    return body.subscriptions
}

/** The same, for an account that is signed in nowhere: a browser of its own, through the API. */
async function serverSubscriptionsOf(
    browser: Parameters<typeof newBrowser>[0],
    account: Account,
): Promise<{ endpoint: string; isActive: boolean }[]> {
    const { context } = await newBrowser(browser)
    try {
        const login = await session(context.request).post('/api/auth/login', {
            identifier: account.email,
            password: account.password,
            token: '',
        })
        expect(login.status()).toBe(200)
        return await serverSubscriptions(context)
    } finally {
        await context.close()
    }
}

async function enablePush(page: Page): Promise<string> {
    await expect(pushToggle(page)).not.toBeChecked()
    const saved = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === '/api/push-subscriptions' &&
            response.request().method() === 'POST',
    )
    await pushToggle(page).check()
    expect((await saved).status()).toBe(200)
    await expect(page.getByText('Push notifications enabled')).toBeVisible()
    const endpoint = await browserEndpoint(page)
    if (endpoint === null) throw new Error('The browser has no push subscription')
    return endpoint
}

async function logoutInUi(page: Page): Promise<void> {
    await page.locator('button.menu-button').click()
    await page.locator('button.logout-item').click()
    await page.waitForURL('**/login')
}

test('a sign-out releases the push subscription: the next account in this browser starts clean', async ({
    browser,
    sink,
}) => {
    const accountA = await createVerifiedAccount(browser, sink)
    const accountB = await createVerifiedAccount(browser, sink)
    const { context, page } = await sharedBrowser(browser)

    await loginInUi(page, accountA)
    const endpointA = await enablePush(page)
    expect(await serverSubscriptions(context)).toEqual([
        expect.objectContaining({ endpoint: endpointA, isActive: true }),
    ])

    await logoutInUi(page)

    // Gone on both sides: the server has nowhere to send A's notifications for this browser.
    expect(await browserEndpoint(page)).toBeNull()
    expect(await serverSubscriptionsOf(browser, accountA)).toEqual([])

    await loginInUi(page, accountB)
    await expect(pushToggle(page)).not.toBeChecked()
    expect(await serverSubscriptions(context)).toEqual([])

    const endpointB = await enablePush(page)
    expect(endpointB).not.toBe(endpointA)
    expect(await serverSubscriptions(context)).toEqual([
        expect.objectContaining({ endpoint: endpointB, isActive: true, notificationLogs: [] }),
    ])
    expect(await serverSubscriptionsOf(browser, accountA)).toEqual([])

    await context.close()
})

test('a subscription left by another account is removed when the next one signs in', async ({
    browser,
    sink,
}) => {
    const accountA = await createVerifiedAccount(browser, sink)
    const accountB = await createVerifiedAccount(browser, sink)
    const { context, page } = await sharedBrowser(browser)

    await loginInUi(page, accountA)
    const endpointA = await enablePush(page)

    // The session ends without a sign-out (the cookies are gone): nothing released the
    // subscription, the browser still has it and the server still has A's record.
    await context.clearCookies()
    expect(await browserEndpoint(page)).toBe(endpointA)

    await loginInUi(page, accountB)

    // B did not enable anything: the leftover is removed, B's settings show push off, and B
    // has no record, so B sees neither A's subscription nor its log.
    await expect.poll(() => browserEndpoint(page)).toBeNull()
    await expect(pushToggle(page)).not.toBeChecked()
    expect(await serverSubscriptions(context)).toEqual([])

    // Enabling is B's own, new subscription; A's record is not moved to B.
    const endpointB = await enablePush(page)
    expect(endpointB).not.toBe(endpointA)
    expect(await serverSubscriptions(context)).toEqual([
        expect.objectContaining({ endpoint: endpointB, isActive: true, notificationLogs: [] }),
    ])
    // A's record still points at the endpoint the browser gave up: the push service answers
    // such a send with 404/410 and the sender deactivates it (push-notification-sender-service).
    expect(await serverSubscriptionsOf(browser, accountA)).toEqual([
        expect.objectContaining({ endpoint: endpointA }),
    ])

    await context.close()
})

test('a refused subscription is not shown as enabled, and trying again saves it', async ({
    browser,
    sink,
}) => {
    const account = await createVerifiedAccount(browser, sink)
    const { context, page } = await sharedBrowser(browser)
    await loginInUi(page, account)

    // The first save fails on the way (the server never sees it).
    await page.route('**/api/push-subscriptions', async (route) => {
        if (route.request().method() === 'POST') {
            await route.abort('connectionfailed')
        } else {
            await route.continue()
        }
    })
    await pushToggle(page).check()
    await expect(page.getByText('Could not subscribe to push notifications')).toBeVisible()
    await expect(pushToggle(page)).not.toBeChecked()
    expect(await serverSubscriptions(context)).toEqual([])
    const endpoint = await browserEndpoint(page)
    expect(endpoint).not.toBeNull()
    await page.unroute('**/api/push-subscriptions')

    // The browser already has the subscription: the retry sends that one to the server.
    expect(await enablePush(page)).toBe(endpoint)
    expect(await serverSubscriptions(context)).toEqual([
        expect.objectContaining({ endpoint, isActive: true }),
    ])

    await context.close()
})
