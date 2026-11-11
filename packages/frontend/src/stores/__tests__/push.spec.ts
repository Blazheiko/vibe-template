import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// feat-076 (J): the push part of the old state store, as a store of its own.

const api = vi.hoisted(() => ({
    getVapidPublicKey: vi.fn(),
    createSubscription: vi.fn(),
    deleteSubscription: vi.fn(),
    getSubscriptions: vi.fn(),
}))
vi.mock('@/utils/api', () => ({ pushSubscriptionApi: api }))

const VAPID = 'B'.repeat(87)

function stubBrowser(options: {
    permission?: NotificationPermission
    existing?: PushSubscription | null
    created?: PushSubscription
}): { subscribe: ReturnType<typeof vi.fn>; requestPermission: ReturnType<typeof vi.fn> } {
    const subscribe = vi.fn().mockResolvedValue(options.created)
    const requestPermission = vi.fn().mockResolvedValue('granted')
    vi.stubGlobal('Notification', {
        permission: options.permission ?? 'default',
        requestPermission,
    })
    vi.stubGlobal('PushManager', {})
    const registration = {
        pushManager: {
            getSubscription: vi.fn().mockResolvedValue(options.existing ?? null),
            subscribe,
        },
    }
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
            ready: Promise.resolve(registration),
            getRegistration: vi.fn().mockResolvedValue(registration),
        },
    })
    return { subscribe, requestPermission }
}

const subscription = (endpoint: string, unsubscribe = vi.fn().mockResolvedValue(true)) =>
    ({
        endpoint,
        unsubscribe,
        getKey: () => new Uint8Array([1, 2, 3]).buffer,
    }) as unknown as PushSubscription

beforeEach(() => {
    setActivePinia(createPinia())
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetAllMocks()
})

describe('push store: permission', () => {
    it('starts from the browser permission and asks only when it is not granted', async () => {
        const { requestPermission } = stubBrowser({ permission: 'granted' })
        const { usePushStore } = await import('../push')
        const store = usePushStore()
        expect(store.notificationPermission).toBe('granted')
        expect(await store.ensureNotificationPermission()).toBe(true)
        expect(requestPermission).not.toHaveBeenCalled()
    })

    it('asks when the permission is open, and remembers the answer', async () => {
        const { requestPermission } = stubBrowser({ permission: 'default' })
        const { usePushStore } = await import('../push')
        const store = usePushStore()
        expect(await store.ensureNotificationPermission()).toBe(true)
        expect(requestPermission).toHaveBeenCalledTimes(1)
        expect(store.notificationPermission).toBe('granted')
    })
})

describe('push store: subscribing', () => {
    // feat-148 (review 2026-11-10, M9): the server sends the notifications, so a subscription
    // the browser already has counts only once the server has it for this account.
    it('sends the subscription the browser already has to the server before reporting it enabled', async () => {
        const existing = subscription('https://push.example/1')
        stubBrowser({ existing })
        let enabledWhenPosted: boolean | undefined
        const { usePushStore } = await import('../push')
        const store = usePushStore()
        api.createSubscription.mockImplementation(() => {
            enabledWhenPosted = store.isSubscribedToPush
            return Promise.resolve({
                data: { status: 'success', subscription: { id: 'sub-1' } },
                error: null,
            })
        })

        expect(await store.subscribeToPush()).toBe(existing)

        expect(api.getVapidPublicKey).not.toHaveBeenCalled()
        expect(api.createSubscription).toHaveBeenCalledWith(
            expect.objectContaining({ endpoint: 'https://push.example/1' }),
        )
        expect(enabledWhenPosted).toBe(false)
        expect(store.isSubscribedToPush).toBe(true)
        expect(store.pushSubscriptionId).toBe('sub-1')
    })

    it('is not enabled when the server refuses the subscription, and a retry posts it again', async () => {
        const created = subscription('https://push.example/2')
        const { subscribe } = stubBrowser({ created })
        api.getVapidPublicKey.mockResolvedValue({
            data: { status: 'success', vapidPublicKey: VAPID },
        })
        api.createSubscription.mockResolvedValueOnce({
            data: null,
            error: { message: 'Too many requests' },
        })
        const { usePushStore } = await import('../push')
        const store = usePushStore()

        expect(await store.subscribeToPush()).toBeNull()
        expect(store.isSubscribedToPush).toBe(false)
        expect(store.pushSubscription).toBeNull()

        // The browser now has the subscription the first attempt created.
        stubBrowser({ existing: created })
        api.createSubscription.mockResolvedValueOnce({
            data: { status: 'success', subscription: { id: 'sub-2' } },
            error: null,
        })

        expect(await store.subscribeToPush()).toBe(created)

        expect(subscribe).toHaveBeenCalledTimes(1)
        expect(api.createSubscription).toHaveBeenCalledTimes(2)
        expect(store.isSubscribedToPush).toBe(true)
        expect(store.pushSubscriptionId).toBe('sub-2')
    })

    it('subscribes with the server key, sends the device to the server and keeps the id it answers with', async () => {
        const created = subscription('https://push.example/2')
        const { subscribe } = stubBrowser({ created })
        api.getVapidPublicKey.mockResolvedValue({
            data: { status: 'success', vapidPublicKey: VAPID },
        })
        api.createSubscription.mockResolvedValue({
            data: { status: 'success', subscription: { id: 'sub-7' } },
            error: null,
        })
        const { usePushStore } = await import('../push')
        const store = usePushStore()

        expect(await store.subscribeToPush()).toBe(created)

        expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }))
        expect(api.createSubscription).toHaveBeenCalledWith(
            expect.objectContaining({
                endpoint: 'https://push.example/2',
                p256dhKey: 'AQID',
                authKey: 'AQID',
                userAgent: navigator.userAgent,
                notificationTypes: ['mention', 'system'],
            }),
        )
        expect(store.pushSubscriptionId).toBe('sub-7')
        expect(store.isSubscribedToPush).toBe(true)
    })

    it('gives up with null when the server has no usable key', async () => {
        stubBrowser({})
        api.getVapidPublicKey.mockResolvedValue({
            data: { status: 'success', vapidPublicKey: 'short' },
        })
        const { usePushStore } = await import('../push')
        const store = usePushStore()
        expect(await store.subscribeToPush()).toBeNull()
        expect(store.isSubscribedToPush).toBe(false)
        expect(api.createSubscription).not.toHaveBeenCalled()
    })
})

describe('push store: unsubscribing and resetting', () => {
    it('is done at once when there is no subscription', async () => {
        stubBrowser({})
        const { usePushStore } = await import('../push')
        expect(await usePushStore().unsubscribeFromPush()).toBe(true)
        expect(api.deleteSubscription).not.toHaveBeenCalled()
    })

    it('unsubscribes the browser, removes the record on the server, and clears the state', async () => {
        const unsubscribe = vi.fn().mockResolvedValue(true)
        const existing = subscription('https://push.example/1', unsubscribe)
        stubBrowser({ existing })
        api.createSubscription.mockResolvedValue({
            data: { status: 'success', subscription: { id: 'sub-7' } },
            error: null,
        })
        api.deleteSubscription.mockResolvedValue({ data: {}, error: null })
        const { usePushStore } = await import('../push')
        const store = usePushStore()
        await store.subscribeToPush()

        expect(await store.unsubscribeFromPush()).toBe(true)

        expect(unsubscribe).toHaveBeenCalled()
        expect(api.deleteSubscription).toHaveBeenCalledWith('sub-7')
        expect(store.isSubscribedToPush).toBe(false)
        expect(store.pushSubscription).toBeNull()
        expect(store.pushSubscriptionId).toBeNull()
    })

    it('resetPushSubscriptionState forgets everything about the subscription (a sign-out)', async () => {
        stubBrowser({ existing: subscription('https://push.example/1') })
        api.createSubscription.mockResolvedValue({
            data: { status: 'success', subscription: { id: 'sub-7' } },
            error: null,
        })
        const { usePushStore } = await import('../push')
        const store = usePushStore()
        await store.subscribeToPush()
        expect(store.isSubscribedToPush).toBe(true)

        store.resetPushSubscriptionState()

        expect(store.isSubscribedToPush).toBe(false)
        expect(store.pushSubscription).toBeNull()
        expect(store.pushSubscriptionId).toBeNull()
    })
})

describe('push store: what the server already knows', () => {
    it('marks this browser subscribed when its endpoint is the active one', async () => {
        const current = subscription('https://push.example/1')
        stubBrowser({ existing: current })
        api.getSubscriptions.mockResolvedValue({
            data: {
                status: 'success',
                subscriptions: [
                    { id: 'a', isActive: false, endpoint: 'https://push.example/0' },
                    { id: 'b', isActive: true, endpoint: 'https://push.example/1' },
                ],
            },
            error: null,
        })
        const { usePushStore } = await import('../push')
        const store = usePushStore()

        await store.ensurePushSubscriptionsLoaded()

        expect(store.pushSubscriptionId).toBe('b')
        expect(store.isSubscribedToPush).toBe(true)
        expect(store.pushSubscription?.endpoint).toBe(current.endpoint)
    })

    // feat-148: "enabled" is about this browser. A subscription that is not a record of the
    // signed-in account was left here by another account: it is removed, so that account's
    // notifications stop arriving in this browser.
    it('removes a subscription another account left in this browser and reports push disabled', async () => {
        const unsubscribe = vi.fn().mockResolvedValue(true)
        stubBrowser({ existing: subscription('https://push.example/9', unsubscribe) })
        api.getSubscriptions.mockResolvedValue({
            data: {
                status: 'success',
                subscriptions: [{ id: 'b', isActive: true, endpoint: 'https://push.example/1' }],
            },
            error: null,
        })
        const { usePushStore } = await import('../push')
        const store = usePushStore()

        await store.ensurePushSubscriptionsLoaded()

        expect(unsubscribe).toHaveBeenCalledTimes(1)
        expect(store.isSubscribedToPush).toBe(false)
        expect(store.pushSubscription).toBeNull()
        expect(store.pushSubscriptionId).toBeNull()
    })

    it('reports push disabled in a browser with no subscription, whatever other devices have', async () => {
        stubBrowser({})
        api.getSubscriptions.mockResolvedValue({
            data: {
                status: 'success',
                subscriptions: [{ id: 'b', isActive: true, endpoint: 'https://push.example/1' }],
            },
            error: null,
        })
        const { usePushStore } = await import('../push')
        const store = usePushStore()

        await store.ensurePushSubscriptionsLoaded()

        expect(store.isSubscribedToPush).toBe(false)
    })

    it('keeps a deactivated subscription of this account in the browser, disabled', async () => {
        const unsubscribe = vi.fn().mockResolvedValue(true)
        stubBrowser({ existing: subscription('https://push.example/1', unsubscribe) })
        api.getSubscriptions.mockResolvedValue({
            data: {
                status: 'success',
                subscriptions: [{ id: 'b', isActive: false, endpoint: 'https://push.example/1' }],
            },
            error: null,
        })
        const { usePushStore } = await import('../push')
        const store = usePushStore()

        await store.ensurePushSubscriptionsLoaded()

        expect(unsubscribe).not.toHaveBeenCalled()
        expect(store.isSubscribedToPush).toBe(false)
        expect(store.pushSubscriptionId).toBe('b')
    })

    it('matches the endpoint in the spelling the server stores', async () => {
        const unsubscribe = vi.fn().mockResolvedValue(true)
        stubBrowser({
            existing: subscription('https://PUSH.example/send/a%2fb', unsubscribe),
        })
        api.getSubscriptions.mockResolvedValue({
            data: {
                status: 'success',
                subscriptions: [
                    { id: 'b', isActive: true, endpoint: 'https://push.example/send/a%2Fb' },
                ],
            },
            error: null,
        })
        const { usePushStore } = await import('../push')
        const store = usePushStore()

        await store.ensurePushSubscriptionsLoaded()

        expect(unsubscribe).not.toHaveBeenCalled()
        expect(store.isSubscribedToPush).toBe(true)
    })

    it('loads once within its window, and again after a reset', async () => {
        stubBrowser({})
        api.getSubscriptions.mockResolvedValue({
            data: { status: 'success', subscriptions: [] },
            error: null,
        })
        const { usePushStore } = await import('../push')
        const store = usePushStore()

        await store.ensurePushSubscriptionsLoaded()
        await store.ensurePushSubscriptionsLoaded()
        expect(api.getSubscriptions).toHaveBeenCalledTimes(1)

        store.resetPushSubscriptionState()
        await store.ensurePushSubscriptionsLoaded()
        expect(api.getSubscriptions).toHaveBeenCalledTimes(2)
    })
})

// feat-148: a sign-out releases this browser's subscription.
describe('push store: releasing the subscription at sign-out', () => {
    it('removes the record on the server, then the subscription in the browser', async () => {
        const order: string[] = []
        const unsubscribe = vi.fn().mockImplementation(() => {
            order.push('unsubscribe')
            return Promise.resolve(true)
        })
        stubBrowser({ existing: subscription('https://push.example/1', unsubscribe) })
        api.getSubscriptions.mockResolvedValue({
            data: {
                status: 'success',
                subscriptions: [{ id: 'b', isActive: true, endpoint: 'https://push.example/1' }],
            },
            error: null,
        })
        api.deleteSubscription.mockImplementation(() => {
            order.push('delete')
            return Promise.resolve({ data: {}, error: null })
        })
        const { usePushStore } = await import('../push')
        const store = usePushStore()

        await store.releaseBrowserSubscription()

        expect(api.deleteSubscription).toHaveBeenCalledWith('b')
        expect(order).toEqual(['delete', 'unsubscribe'])
    })

    it('does nothing in a browser with no subscription', async () => {
        stubBrowser({})
        const { usePushStore } = await import('../push')

        await usePushStore().releaseBrowserSubscription()

        expect(api.getSubscriptions).not.toHaveBeenCalled()
        expect(api.deleteSubscription).not.toHaveBeenCalled()
    })

    it('still removes the subscription in the browser when the server cannot be reached', async () => {
        const unsubscribe = vi.fn().mockResolvedValue(true)
        stubBrowser({ existing: subscription('https://push.example/1', unsubscribe) })
        api.getSubscriptions.mockRejectedValue(new Error('offline'))
        const { usePushStore } = await import('../push')

        await expect(usePushStore().releaseBrowserSubscription()).resolves.toBeUndefined()

        expect(unsubscribe).toHaveBeenCalledTimes(1)
    })

    it('does not fail the sign-out when the browser cannot unsubscribe', async () => {
        const unsubscribe = vi.fn().mockRejectedValue(new Error('push service down'))
        stubBrowser({ existing: subscription('https://push.example/1', unsubscribe) })
        api.getSubscriptions.mockResolvedValue({
            data: { status: 'success', subscriptions: [] },
            error: null,
        })
        const { usePushStore } = await import('../push')

        await expect(usePushStore().releaseBrowserSubscription()).resolves.toBeUndefined()
    })

    it('gives up after three seconds: a slow push service does not hold the sign-out', async () => {
        vi.useFakeTimers()
        try {
            const unsubscribe = vi.fn().mockReturnValue(new Promise(() => undefined))
            stubBrowser({ existing: subscription('https://push.example/1', unsubscribe) })
            api.getSubscriptions.mockResolvedValue({
                data: { status: 'success', subscriptions: [] },
                error: null,
            })
            const { usePushStore } = await import('../push')
            let released = false

            const release = usePushStore()
                .releaseBrowserSubscription()
                .then(() => {
                    released = true
                })
            await vi.advanceTimersByTimeAsync(2999)
            expect(released).toBe(false)
            await vi.advanceTimersByTimeAsync(1)
            await release

            expect(released).toBe(true)
        } finally {
            vi.useRealTimers()
        }
    })
})
