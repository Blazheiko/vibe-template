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
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
            ready: Promise.resolve({
                pushManager: {
                    getSubscription: vi.fn().mockResolvedValue(options.existing ?? null),
                    subscribe,
                },
            }),
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
    it('takes the subscription the browser already has, without asking the server for a key', async () => {
        const existing = subscription('https://push.example/1')
        stubBrowser({ existing })
        const { usePushStore } = await import('../push')
        const store = usePushStore()
        expect(await store.subscribeToPush()).toBe(existing)
        expect(store.isSubscribedToPush).toBe(true)
        expect(api.getVapidPublicKey).not.toHaveBeenCalled()
    })

    it('subscribes with the server key, sends the device to the server and keeps the id it answers with', async () => {
        const created = subscription('https://push.example/2')
        const { subscribe } = stubBrowser({ created })
        api.getVapidPublicKey.mockResolvedValue({ data: { vapidPublicKey: VAPID } })
        api.createSubscription.mockResolvedValue({
            data: { subscription: { id: 'sub-7' } },
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
        api.getVapidPublicKey.mockResolvedValue({ data: { vapidPublicKey: 'short' } })
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
        api.deleteSubscription.mockResolvedValue({ data: {}, error: null })
        const { usePushStore } = await import('../push')
        const store = usePushStore()
        await store.subscribeToPush()
        store.pushSubscriptionId = 'sub-7'

        expect(await store.unsubscribeFromPush()).toBe(true)

        expect(unsubscribe).toHaveBeenCalled()
        expect(api.deleteSubscription).toHaveBeenCalledWith('sub-7')
        expect(store.isSubscribedToPush).toBe(false)
        expect(store.pushSubscription).toBeNull()
        expect(store.pushSubscriptionId).toBeNull()
    })

    it('resetPushSubscriptionState forgets everything about the subscription (a sign-out)', async () => {
        stubBrowser({ existing: subscription('https://push.example/1') })
        const { usePushStore } = await import('../push')
        const store = usePushStore()
        await store.subscribeToPush()
        store.pushSubscriptionId = 'sub-7'

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

    it('knows the account is subscribed (somewhere) even when this browser is not the one', async () => {
        stubBrowser({ existing: subscription('https://push.example/9') })
        api.getSubscriptions.mockResolvedValue({
            data: [{ id: 'b', isActive: true, endpoint: 'https://push.example/1' }],
            error: null,
        })
        const { usePushStore } = await import('../push')
        const store = usePushStore()

        await store.ensurePushSubscriptionsLoaded()

        expect(store.isSubscribedToPush).toBe(true)
        expect(store.pushSubscription).toBeNull()
    })

    it('loads once within its window, and again after a reset', async () => {
        stubBrowser({})
        api.getSubscriptions.mockResolvedValue({ data: { subscriptions: [] }, error: null })
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
