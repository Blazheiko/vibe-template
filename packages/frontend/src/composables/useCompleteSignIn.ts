import { useRoute, useRouter } from 'vue-router'
import { useEventBus } from '@/utils/event-bus'
import { useUserStore } from '@/stores/user'
import { forgetPostSignInTarget } from '@/utils/post-sign-in-target'
import { safeRedirectTarget } from '@/utils/safe-redirect'

type SignedInUser = Parameters<ReturnType<typeof useUserStore>['setUser']>[0]

/**
 * What a successful sign-in or registration does, in this order: remember the user, let the
 * caller close the modal and announce it (`onSignedIn`), open the page the visitor was going to
 * (or the account page), and have the app read the session again.
 *
 * The page comes from `?redirect=`, which the router guard writes when it sends an anonymous
 * visitor to /login. It is read first: closing the modal replaces the route, and the query goes
 * with it (feat-154). The app reads the session only after the navigation settled, so its own
 * "where to after a sign-in" rule sees the new page and leaves it alone.
 */
export function useCompleteSignIn(onSignedIn: () => void) {
    const router = useRouter()
    const route = useRoute()
    const userStore = useUserStore()
    const eventBus = useEventBus()

    return (user: SignedInUser): void => {
        const intended = safeRedirectTarget(route.query.redirect)
        // A target kept for an OAuth sign-in that was started and not finished is not this one's.
        forgetPostSignInTarget()
        userStore.setUser(user)
        onSignedIn()
        const readSession = (): void => {
            eventBus.emit('init_app')
        }
        void Promise.resolve(router.push(intended ?? { name: 'UserAccount' })).then(
            readSession,
            readSession,
        )
    }
}
