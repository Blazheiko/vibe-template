import { useRouter } from 'vue-router'
import { LOGOUT_RETRY_REASON } from 'shared/errors'
import { authApi, mainApi } from '@/utils/api'
import type { ApiResponse } from '@/utils/api-error'
import { getErrorReason, isUnauthorizedError } from '@/utils/response-normalizer'
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
        console.error('Push sign-out step error:', error)
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
     * A sign-out request repeated while the server answers `logout_retry`: `left` (the server
     * ended the session), `kept` (it kept the session through every repeat) or `unknown` (any other
     * failure, a lost answer included: the session may or may not have ended). Logged.
     */
    const sendSignOut = async (
        send: () => Promise<ApiResponse<unknown>>,
    ): Promise<'left' | 'kept' | 'unknown'> => {
        for (let attempt = 0; ; attempt++) {
            try {
                const { data, error } = await send()
                if (!error) return 'left'
                if (getErrorReason(data) !== LOGOUT_RETRY_REASON) {
                    console.error(error)
                    return 'unknown'
                }
            } catch (error) {
                console.error('Logout error:', error)
                return 'unknown'
            }
            if (attempt >= LOGOUT_RETRIES) return 'kept'
            await wait(LOGOUT_RETRY_DELAY_MS)
        }
    }

    /**
     * Whether the server kept the session through every repeat of the logout (`logout_retry`).
     * Any other failure leaves as before (feat-256 keeps this for the plain logout). `pushEndpoint`
     * (feat-254): the server deletes this browser's push record with the session, only when it
     * really ended.
     */
    const sendLogout = async (pushEndpoint: string | null): Promise<'kept' | 'left'> =>
        (await sendSignOut(() => authApi.logout(pushEndpoint))) === 'kept' ? 'kept' : 'left'

    /** Whether main/init sees no signed-in session any more (a 401); false when it cannot tell. */
    const sessionEnded = async (): Promise<boolean> => {
        try {
            const { data, error } = await mainApi.init()
            return error !== null && isUnauthorizedError(data, error.transportCode)
        } catch (error) {
            console.error('Session check error:', error)
            return false
        }
    }

    /**
     * Signs out and opens /login. Answers false when the server kept the session through every
     * repeat (Р13): the browser stays signed in and the caller tells the user the sign-out did
     * not finish. Push (feat-148, feat-254) is best effort and bounded at every step: the request
     * names this browser's endpoint and the server deletes its record only with the session; the
     * browser's subscription goes once the sign-out went through. A kept session keeps both, so
     * push keeps working and nothing has to be put back.
     */
    const logout = async (): Promise<boolean> => {
        let pushEndpoint: string | null = null
        await quietly(async () => {
            pushEndpoint = await pushStore.currentPushEndpoint()
        })
        if ((await sendLogout(pushEndpoint)) === 'kept') return false
        await quietly(() => pushStore.unsubscribeBrowser())
        await redirectToLogin()
        return true
    }

    /**
     * feat-256 (docs/plan/mfa-review-fixes-7-plan.md, item 5): ends a recovery session (Р8). The
     * browser leaves for /login only once the end is confirmed: the server answered it, or, after
     * an unknown outcome (a lost answer, a 5xx), main/init sees no session any more. `kept` and
     * `unknown` leave the user where they are, signed in, for the caller to say so.
     */
    const finishRecovery = async (): Promise<'left' | 'kept' | 'unknown'> => {
        let outcome = await sendSignOut(() => authApi.recoveryFinish())
        if (outcome === 'unknown' && (await sessionEnded())) outcome = 'left'
        if (outcome === 'left') await redirectToLogin()
        return outcome
    }

    return {
        resetSessionScopedState,
        redirectToLogin,
        logout,
        finishRecovery,
    }
}
