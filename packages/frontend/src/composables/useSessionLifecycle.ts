import { useRouter } from 'vue-router'
import { LOGOUT_RETRY_REASON } from 'shared/errors'
import { authApi } from '@/utils/api'
import { getErrorReason } from '@/utils/response-normalizer'
import { useSupportStore } from '@/stores/support'
import { usePushStore } from '@/stores/push'
import { useUserStore } from '@/stores/user'
import { useWebSocketConnection } from '@/composables/useWebSocketConnection'

/**
 * docs/plan/passkeys-mfa-plan.md (Р13): a 503 `logout_retry` means the server kept the session (a
 * role change or an MFA reset sent from it is still committing): the logout is sent again after a
 * pause, at most this many times.
 */
export const LOGOUT_RETRIES = 3
export const LOGOUT_RETRY_DELAY_MS = 1000
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A push step of the sign-out: its failure is logged and never holds the sign-out. */
const quietly = async (step: () => Promise<void>): Promise<void> => {
    try {
        await step()
    } catch (error) {
        console.error('Push release error:', error)
    }
}

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

    /**
     * Whether the server kept the session through every repeat of the logout (`logout_retry`).
     * Any other failure is logged and the browser leaves as before.
     */
    const sendLogout = async (): Promise<'kept' | 'left'> => {
        for (let attempt = 0; ; attempt++) {
            try {
                const { data, error } = await authApi.logout()
                if (!error) return 'left'
                if (getErrorReason(data) !== LOGOUT_RETRY_REASON) {
                    console.error(error)
                    return 'left'
                }
            } catch (error) {
                console.error('Logout error:', error)
                return 'left'
            }
            if (attempt >= LOGOUT_RETRIES) return 'kept'
            await wait(LOGOUT_RETRY_DELAY_MS)
        }
    }

    /**
     * Signs out and opens /login. Answers false when the server kept the session through every
     * repeat (Р13): the browser stays signed in and the caller tells the user the sign-out did
     * not finish. Push (feat-148) is best effort and bounded at every step: the server record
     * goes while the session still exists, the browser's subscription only once the sign-out went
     * through; a kept session gets its record back, so push keeps working.
     */
    const logout = async (): Promise<boolean> => {
        await quietly(() => pushStore.releaseServerSubscription())
        if ((await sendLogout()) === 'kept') {
            // A record whose removal outlives the restore's bound is put back later, while this
            // account is still the signed-in one.
            const userId = userStore.user?.id ?? null
            const isSignedIn = () => userId !== null && userStore.user?.id === userId
            await quietly(() => pushStore.restoreServerSubscription(isSignedIn))
            return false
        }
        await quietly(() => pushStore.unsubscribeBrowser())
        await redirectToLogin()
        return true
    }

    return {
        resetSessionScopedState,
        redirectToLogin,
        logout,
    }
}
