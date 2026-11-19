import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { InitResponse, Profile } from 'shared'
import { sentryService as sentry } from '@/utils/sentry-service'

// Tracks the currently active initializeApp() cycle.
let _resolveReady: (() => void) | null = null
let _readyPromise: Promise<void> = Promise.resolve()

function createReadyPromise(): void {
    _readyPromise = new Promise<void>((resolve) => {
        _resolveReady = resolve
    })
}

export function waitForApp(): Promise<void> {
    return _readyPromise
}

export interface User {
    id: string
    name?: string
    email?: string | null
    phone?: string | null
    emailVerified?: boolean
    emailVerifiedAt?: string | null
    avatar?: string | null
    role?: 'user' | 'admin'
    [key: string]: string | number | boolean | null | undefined
}

type InitUser = NonNullable<Extract<InitResponse, { status: 'ok' }>['user']>

/**
 * Whether `next` may replace `current` (feat-232, Р12): a snapshot with a lower revision is older
 * than the one shown and is dropped. The revision is a decimal string compared as a number.
 */
export function isNewerOrSameRevision(next: string, current: string | undefined): boolean {
    if (current === undefined) return true
    try {
        return BigInt(next) >= BigInt(current)
    } catch {
        return false
    }
}

export const useUserStore = defineStore('user', () => {
    const user = ref<User | null>(null)
    /** The confirmed profile of `user` (the last server snapshot applied); null until init. */
    const profile = ref<Profile | null>(null)
    /**
     * Nobody is signed in, and that is known: the server said so (401) or the user signed out.
     * False while the session is not checked yet, when `user` is null only for lack of an answer.
     */
    const anonymousConfirmed = ref(false)

    function setUser(userData: User) {
        // Another account: the profile of the previous one never stays (Р10).
        if (user.value?.id !== userData.id) profile.value = null
        user.value = userData
        anonymousConfirmed.value = false
        sentry.setUser({ id: userData.id })
    }

    /** The user of GET /main/init with the profile it carries (Р6). */
    function setInitUser(initUser: InitUser) {
        const { preferences, revision, ...rest } = initUser
        setUser(rest)
        applyProfile({ name: rest.name, preferences, revision })
    }

    /**
     * Applies a server snapshot of the profile of the signed-in user unless it is older than the
     * one shown (Р12). Returns whether it was applied.
     */
    function applyProfile(snapshot: Profile): boolean {
        if (user.value === null) return false
        if (!isNewerOrSameRevision(snapshot.revision, profile.value?.revision)) return false
        profile.value = {
            name: snapshot.name,
            preferences: { ...snapshot.preferences },
            revision: snapshot.revision,
        }
        if (user.value.name !== snapshot.name) user.value = { ...user.value, name: snapshot.name }
        return true
    }

    function clearUser() {
        user.value = null
        profile.value = null
        anonymousConfirmed.value = true
        sentry.setUser(null)
    }

    /** The server answered that this session has no user. */
    function markAnonymous() {
        if (user.value === null) anonymousConfirmed.value = true
    }

    function hasUser() {
        return user.value !== null
    }

    function isAdmin() {
        return user.value?.role === 'admin'
    }

    function resetReady() {
        createReadyPromise()
    }

    function markReady() {
        _resolveReady?.()
        _resolveReady = null
    }

    return {
        user,
        profile,
        anonymousConfirmed,
        markAnonymous,
        setUser,
        setInitUser,
        applyProfile,
        clearUser,
        hasUser,
        isAdmin,
        resetReady,
        markReady,
    }
})
