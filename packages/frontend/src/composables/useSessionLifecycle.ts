import { useRouter } from 'vue-router'
import { authApi } from '@/utils/api'
import { useSupportStore } from '@/stores/support'
import { usePushStore } from '@/stores/push'
import { useUserStore } from '@/stores/user'
import { useWebSocketConnection } from '@/composables/useWebSocketConnection'

export const useSessionLifecycle = () => {
    const router = useRouter()
    const supportStore = useSupportStore()
    const pushStore = usePushStore()
    const userStore = useUserStore()
    const { websocketClose } = useWebSocketConnection()

    const resetSessionScopedState = () => {
        supportStore.reset()
        pushStore.resetPushSubscriptionState()
    }

    /** `returnTo` (feat-245): the page to come back to after signing in again. */
    const redirectToLogin = async (returnTo?: string) => {
        resetSessionScopedState()
        websocketClose()
        userStore.clearUser()
        await router.push(
            returnTo === undefined ? '/login' : { path: '/login', query: { redirect: returnTo } },
        )
    }

    const logout = async () => {
        // While the session still exists: the server record needs it (feat-148). On its own,
        // so that a failure here never skips the logout request.
        try {
            await pushStore.releaseBrowserSubscription()
        } catch (error) {
            console.error('Push release error:', error)
        }
        try {
            const { error } = await authApi.logout()
            if (error) {
                console.error(error)
            }
        } catch (error) {
            console.error('Logout error:', error)
        } finally {
            await redirectToLogin()
        }
    }

    return {
        resetSessionScopedState,
        redirectToLogin,
        logout,
    }
}
