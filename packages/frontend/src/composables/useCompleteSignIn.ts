import { useRouter } from 'vue-router'
import { useEventBus } from '@/utils/event-bus'
import { useUserStore } from '@/stores/user'

type SignedInUser = Parameters<ReturnType<typeof useUserStore>['setUser']>[0]

/**
 * What a successful sign-in or registration does, in this order: remember the user, let the
 * caller close the modal and announce it (`onSignedIn`), open the account page, and have the app
 * read the session again.
 */
export function useCompleteSignIn(onSignedIn: () => void) {
    const router = useRouter()
    const userStore = useUserStore()
    const eventBus = useEventBus()

    return (user: SignedInUser): void => {
        userStore.setUser(user)
        onSignedIn()
        void router.push({ name: 'UserAccount' })
        eventBus.emit('init_app')
    }
}
