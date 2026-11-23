import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// feat-148: a sign-out removes this browser's push record while the session still exists, and
// unsubscribes the browser only once the sign-out went through; a session the server kept
// (Р13 `logout_retry`) gets its record back. A push failure never holds the sign-out.

const order: string[] = []

const push = vi.hoisted(() => vi.fn())
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

const authApi = vi.hoisted(() => ({ logout: vi.fn() }))
vi.mock('@/utils/api', () => ({ authApi }))

const pushStore = vi.hoisted(() => ({
    releaseServerSubscription: vi.fn(),
    unsubscribeBrowser: vi.fn(),
    restoreServerSubscription: vi.fn(),
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
    pushStore.releaseServerSubscription.mockImplementation(() => {
        order.push('release push record')
        return Promise.resolve()
    })
    pushStore.unsubscribeBrowser.mockImplementation(() => {
        order.push('unsubscribe browser')
        return Promise.resolve()
    })
    pushStore.restoreServerSubscription.mockImplementation(() => {
        order.push('restore push record')
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
    it('removes the push record before the logout request, unsubscribes the browser after it, then resets and leaves', async () => {
        const { useSessionLifecycle } = await import('../useSessionLifecycle')

        await useSessionLifecycle().logout()

        expect(order).toEqual([
            'release push record',
            'logout request',
            'unsubscribe browser',
            'reset state',
        ])
        expect(pushStore.restoreServerSubscription).not.toHaveBeenCalled()
        expect(websocketClose).toHaveBeenCalledTimes(1)
        expect(userStore.clearUser).toHaveBeenCalledTimes(1)
        expect(push).toHaveBeenCalledWith('/login')
    })

    it('still signs out and leaves when a push step throws', async () => {
        pushStore.releaseServerSubscription.mockRejectedValue(new Error('push service down'))
        pushStore.unsubscribeBrowser.mockRejectedValue(new Error('push service down'))
        const { useSessionLifecycle } = await import('../useSessionLifecycle')

        await useSessionLifecycle().logout()

        expect(authApi.logout).toHaveBeenCalledTimes(1)
        expect(userStore.clearUser).toHaveBeenCalledTimes(1)
        expect(push).toHaveBeenCalledWith('/login')
    })

    it('a lost session (redirectToLogin) does not touch the subscription: the server would refuse', async () => {
        const { useSessionLifecycle } = await import('../useSessionLifecycle')

        await useSessionLifecycle().redirectToLogin()

        expect(pushStore.releaseServerSubscription).not.toHaveBeenCalled()
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
        expect(pushStore.unsubscribeBrowser).toHaveBeenCalledTimes(1)
        expect(pushStore.restoreServerSubscription).not.toHaveBeenCalled()
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
        // Still signed in: the browser subscription was never touched and the record is back.
        expect(pushStore.unsubscribeBrowser).not.toHaveBeenCalled()
        expect(order[0]).toBe('release push record')
        expect(order[order.length - 1]).toBe('restore push record')
        expect(userStore.clearUser).not.toHaveBeenCalled()
        expect(websocketClose).not.toHaveBeenCalled()
        expect(push).not.toHaveBeenCalled()
    })

    // feat-252: a record whose removal outlived the bound is put back later, only while the
    // account that signed out is still the signed-in one.
    it('kept: the restore is told whether the same account is still signed in', async () => {
        authApi.logout.mockImplementation(retryAnswer)
        const { useSessionLifecycle } = await import('../useSessionLifecycle')

        const done = useSessionLifecycle().logout()
        await vi.runAllTimersAsync()
        expect(await done).toBe(false)

        const isSignedIn = pushStore.restoreServerSubscription.mock.calls[0]?.[0] as () => boolean
        expect(isSignedIn()).toBe(true)
        userStore.user = { id: '8' }
        expect(isSignedIn()).toBe(false)
        userStore.user = null
        expect(isSignedIn()).toBe(false)
    })

    it('kept, and restoring the record fails: still answers false, nothing thrown', async () => {
        authApi.logout.mockImplementation(retryAnswer)
        pushStore.restoreServerSubscription.mockRejectedValue(new Error('offline'))
        const { useSessionLifecycle } = await import('../useSessionLifecycle')

        const done = useSessionLifecycle().logout()
        await vi.runAllTimersAsync()

        expect(await done).toBe(false)
        expect(pushStore.unsubscribeBrowser).not.toHaveBeenCalled()
        expect(userStore.clearUser).not.toHaveBeenCalled()
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
