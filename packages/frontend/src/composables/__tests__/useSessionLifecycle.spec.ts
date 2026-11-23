import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// feat-148, feat-254: a sign-out names this browser's push endpoint in its request (the server
// deletes the record with the session) and unsubscribes the browser only once the sign-out went
// through; a session the server kept (Р13 `logout_retry`) keeps both, and no push-subscription
// API is called. A push failure never holds the sign-out.

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/this-browser'

const order: string[] = []

const push = vi.hoisted(() => vi.fn())
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

const authApi = vi.hoisted(() => ({ logout: vi.fn() }))
// Any push-subscription request of a sign-out would show here.
const pushSubscriptionApi = vi.hoisted(() => ({
    getSubscriptions: vi.fn(),
    createSubscription: vi.fn(),
    deleteSubscription: vi.fn(),
}))
vi.mock('@/utils/api', () => ({ authApi, pushSubscriptionApi }))

const pushStore = vi.hoisted(() => ({
    currentPushEndpoint: vi.fn(),
    unsubscribeBrowser: vi.fn(),
    resetPushSubscriptionState: vi.fn(),
}))
vi.mock('@/stores/push', () => ({ usePushStore: () => pushStore }))

const supportStore = vi.hoisted(() => ({ reset: vi.fn() }))
vi.mock('@/stores/support', () => ({ useSupportStore: () => supportStore }))

const userStore = vi.hoisted(() => ({
    clearUser: vi.fn(),
    user: null as { id: string } | null,
}))
vi.mock('@/stores/user', () => ({ useUserStore: () => userStore }))

const websocketClose = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useWebSocketConnection', () => ({
    useWebSocketConnection: () => ({ websocketClose }),
}))

beforeEach(() => {
    order.length = 0
    vi.clearAllMocks()
    userStore.user = { id: '7' }
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    pushStore.currentPushEndpoint.mockImplementation(() => {
        order.push('read push endpoint')
        return Promise.resolve(ENDPOINT)
    })
    pushStore.unsubscribeBrowser.mockImplementation(() => {
        order.push('unsubscribe browser')
        return Promise.resolve()
    })
    authApi.logout.mockImplementation(() => {
        order.push('logout request')
        return Promise.resolve({ data: {}, error: null })
    })
    pushStore.resetPushSubscriptionState.mockImplementation(() => {
        order.push('reset state')
    })
    push.mockResolvedValue(undefined)
})

describe('useSessionLifecycle: logout', () => {
    it('sends the push endpoint with the logout request, unsubscribes the browser after it, then resets and leaves', async () => {
        const { useSessionLifecycle } = await import('../useSessionLifecycle')

        expect(await useSessionLifecycle().logout()).toBe(true)

        expect(order).toEqual([
            'read push endpoint',
            'logout request',
            'unsubscribe browser',
            'reset state',
        ])
        expect(authApi.logout).toHaveBeenCalledExactlyOnceWith(ENDPOINT)
        expect(pushSubscriptionApi.deleteSubscription).not.toHaveBeenCalled()
        expect(websocketClose).toHaveBeenCalledTimes(1)
        expect(userStore.clearUser).toHaveBeenCalledTimes(1)
        expect(push).toHaveBeenCalledWith('/login')
    })

    it('no subscription in this browser: the logout names no endpoint', async () => {
        pushStore.currentPushEndpoint.mockResolvedValue(null)
        const { useSessionLifecycle } = await import('../useSessionLifecycle')

        expect(await useSessionLifecycle().logout()).toBe(true)

        expect(authApi.logout).toHaveBeenCalledExactlyOnceWith(null)
        expect(push).toHaveBeenCalledWith('/login')
    })

    it('still signs out and leaves when a push step throws', async () => {
        pushStore.currentPushEndpoint.mockRejectedValue(new Error('push service down'))
        pushStore.unsubscribeBrowser.mockRejectedValue(new Error('push service down'))
        const { useSessionLifecycle } = await import('../useSessionLifecycle')

        await useSessionLifecycle().logout()

        expect(authApi.logout).toHaveBeenCalledExactlyOnceWith(null)
        expect(userStore.clearUser).toHaveBeenCalledTimes(1)
        expect(push).toHaveBeenCalledWith('/login')
    })

    it('a lost session (redirectToLogin) does not touch the subscription: the server would refuse', async () => {
        const { useSessionLifecycle } = await import('../useSessionLifecycle')

        await useSessionLifecycle().redirectToLogin()

        expect(pushStore.currentPushEndpoint).not.toHaveBeenCalled()
        expect(pushStore.unsubscribeBrowser).not.toHaveBeenCalled()
        expect(authApi.logout).not.toHaveBeenCalled()
        expect(push).toHaveBeenCalledWith('/login')
    })
})

// docs/plan/passkeys-mfa-plan.md (Р13): a 503 `logout_retry` means the server kept the session.
describe('useSessionLifecycle: a logout the server asks to repeat', () => {
    const retryAnswer = () =>
        Promise.resolve({
            data: {
                status: 'error',
                code: 'service_unavailable',
                message: 'Signing out is still finishing. Try again in a moment.',
                reason: 'logout_retry',
            },
            error: { code: 'service_unavailable', transportCode: 503, message: 'x' },
        })

    beforeEach(() => {
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('repeats it after a pause and leaves once it went through', async () => {
        authApi.logout.mockImplementationOnce(retryAnswer)
        const { useSessionLifecycle } = await import('../useSessionLifecycle')

        const done = useSessionLifecycle().logout()
        await vi.runAllTimersAsync()

        expect(await done).toBe(true)
        expect(authApi.logout).toHaveBeenCalledTimes(2)
        // Every repeat names the endpoint: the one that goes through deletes the record.
        expect(authApi.logout).toHaveBeenNthCalledWith(2, ENDPOINT)
        expect(pushStore.currentPushEndpoint).toHaveBeenCalledTimes(1)
        expect(pushStore.unsubscribeBrowser).toHaveBeenCalledTimes(1)
        expect(userStore.clearUser).toHaveBeenCalledTimes(1)
        expect(push).toHaveBeenCalledWith('/login')
    })

    it('gives up after a few repeats: stays signed in and answers false', async () => {
        authApi.logout.mockImplementation(retryAnswer)
        const { useSessionLifecycle, LOGOUT_RETRIES } = await import('../useSessionLifecycle')

        const done = useSessionLifecycle().logout()
        await vi.runAllTimersAsync()

        expect(await done).toBe(false)
        expect(authApi.logout).toHaveBeenCalledTimes(LOGOUT_RETRIES + 1)
        // Still signed in: the record (the server kept it with the session) and the browser's
        // subscription are both intact, and nothing has to be put back.
        expect(pushStore.unsubscribeBrowser).not.toHaveBeenCalled()
        expect(pushStore.resetPushSubscriptionState).not.toHaveBeenCalled()
        for (const call of Object.values(pushSubscriptionApi)) expect(call).not.toHaveBeenCalled()
        expect(order.filter((step) => step !== 'logout request')).toEqual(['read push endpoint'])
        expect(userStore.clearUser).not.toHaveBeenCalled()
        expect(websocketClose).not.toHaveBeenCalled()
        expect(push).not.toHaveBeenCalled()
    })

    it('another failure is not repeated: the browser leaves as before', async () => {
        authApi.logout.mockResolvedValue({
            data: { status: 'error', code: 'internal_error', message: 'Failed to log out user' },
            error: { code: 'internal_error', transportCode: 500, message: 'x' },
        })
        const { useSessionLifecycle } = await import('../useSessionLifecycle')

        expect(await useSessionLifecycle().logout()).toBe(true)
        expect(authApi.logout).toHaveBeenCalledTimes(1)
        expect(push).toHaveBeenCalledWith('/login')
    })
})
