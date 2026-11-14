import { beforeEach, describe, expect, it, vi } from 'vitest'

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
