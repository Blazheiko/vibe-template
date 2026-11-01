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

    const redirectToLogin = async () => {
        resetSessionScopedState()
        websocketClose()
        userStore.clearUser()
        await router.push('/login')
    }

    const logout = async () => {
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
