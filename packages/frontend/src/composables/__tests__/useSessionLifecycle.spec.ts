import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// feat-148: a sign-out releases this browser's push subscription while the session still
// exists, and never waits on it longer than the store allows.

const order: string[] = []

const push = vi.hoisted(() => vi.fn())
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

const authApi = vi.hoisted(() => ({ logout: vi.fn() }))
vi.mock('@/utils/api', () => ({ authApi }))

const pushStore = vi.hoisted(() => ({
    releaseBrowserSubscription: vi.fn(),
    resetPushSubscriptionState: vi.fn(),
}))
vi.mock('@/stores/push', () => ({ usePushStore: () => pushStore }))

const supportStore = vi.hoisted(() => ({ reset: vi.fn() }))
vi.mock('@/stores/support', () => ({ useSupportStore: () => supportStore }))

const userStore = vi.hoisted(() => ({ clearUser: vi.fn() }))
vi.mock('@/stores/user', () => ({ useUserStore: () => userStore }))

const websocketClose = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useWebSocketConnection', () => ({
    useWebSocketConnection: () => ({ websocketClose }),
}))

beforeEach(() => {
    order.length = 0
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    pushStore.releaseBrowserSubscription.mockImplementation(() => {
        order.push('release push')
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
    it('releases the push subscription before the logout request, then resets and leaves', async () => {
        const { useSessionLifecycle } = await import('../useSessionLifecycle')

        await useSessionLifecycle().logout()

        expect(order).toEqual(['release push', 'logout request', 'reset state'])
        expect(websocketClose).toHaveBeenCalledTimes(1)
        expect(userStore.clearUser).toHaveBeenCalledTimes(1)
        expect(push).toHaveBeenCalledWith('/login')
    })

    it('still signs out and leaves when releasing the subscription throws', async () => {
        pushStore.releaseBrowserSubscription.mockRejectedValue(new Error('push service down'))
        const { useSessionLifecycle } = await import('../useSessionLifecycle')

        await useSessionLifecycle().logout()

        expect(authApi.logout).toHaveBeenCalledTimes(1)
        expect(userStore.clearUser).toHaveBeenCalledTimes(1)
        expect(push).toHaveBeenCalledWith('/login')
    })

    it('a lost session (redirectToLogin) does not touch the subscription: the server would refuse', async () => {
        const { useSessionLifecycle } = await import('../useSessionLifecycle')

        await useSessionLifecycle().redirectToLogin()

        expect(pushStore.releaseBrowserSubscription).not.toHaveBeenCalled()
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
