import { ref } from 'vue'
import { defineStore } from 'pinia'
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

export const useUserStore = defineStore('user', () => {
    const user = ref<User | null>(null)

    function setUser(userData: User) {
        user.value = userData
        sentry.setUser({ id: userData.id })
    }

    function clearUser() {
        user.value = null
        sentry.setUser(null)
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

    return { user, setUser, clearUser, hasUser, isAdmin, resetReady, markReady }
})
