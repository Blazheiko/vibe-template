import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { InitResponse, Profile, Role } from 'shared'
import { isStaffRole, roleHasPermission, type Permission } from 'shared/access'
import { sentryService as sentry } from '@/utils/sentry-service'
import type { StaffMfaReason } from '@/utils/staff-mfa'

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
    role?: Role
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
    /**
     * feat-245 (Р8): set while this session is a recovery session (main/init says so). The app
     * shows only the recovery wizard then: every other route answers 403 recovery_session.
     */
    const recovery = ref<{ expiresAt: string; replaced: boolean } | null>(null)
    /**
     * feat-240 (Р8): grows with every `access_changed` of this tab's socket and with every change
     * of account. A role read over HTTP is applied only when it has not grown since the read
     * started, so an answer that left before a change never brings the old role back.
     */
    let accessEpoch = 0
    let accessReads = 0
    /**
     * feat-247 (Р10): the admin area answered this session 403 `mfa_required` or
     * `mfa_session_required`. The staff routes lead to the account's security section until a
     * new sign-in (or a new init) sets the user again; the backend still checks every request.
     */
    const staffMfaRefusal = ref<StaffMfaReason | null>(null)

    function setStaffMfaRefusal(reason: StaffMfaReason | null): void {
        staffMfaRefusal.value = reason
    }

    function setUser(userData: User) {
        // Another account: the profile of the previous one never stays (Р10).
        if (user.value?.id !== userData.id) {
            profile.value = null
            accessEpoch += 1
        }
        user.value = userData
        staffMfaRefusal.value = null
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

    function setRecovery(state: { expiresAt: string; replaced: boolean } | null) {
        recovery.value = state
    }

    function clearUser() {
        accessEpoch += 1
        user.value = null
        profile.value = null
        recovery.value = null
        staffMfaRefusal.value = null
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

    /** Whether the role may use `permission` (the backend checks every request anyway). */
    function can(permission: Permission): boolean {
        return roleHasPermission(user.value?.role, permission)
    }

    /** A role with at least one admin permission. */
    function isStaff(): boolean {
        return isStaffRole(user.value?.role)
    }

    /** `access_changed` of this tab's socket: the role already applied to it on the server. */
    function applyAccessChanged(role: Role): void {
        accessEpoch += 1
        if (user.value !== null && user.value.role !== role) user.value = { ...user.value, role }
    }

    /** Starts a role read over HTTP; hand the ticket back with its answer. */
    function beginAccessRead(): { epoch: number; read: number; userId: string | null } {
        accessReads += 1
        return { epoch: accessEpoch, read: accessReads, userId: user.value?.id ?? null }
    }

    /**
     * Applies the role a read answered, unless a newer read started, an `access_changed` came or
     * the account changed meanwhile. Returns whether it was applied.
     */
    function applyAccessRead(
        ticket: { epoch: number; read: number; userId: string | null },
        role: Role,
    ): boolean {
        if (ticket.read !== accessReads || ticket.epoch !== accessEpoch) return false
        const current = user.value
        if (current === null) return false
        if (current.id !== ticket.userId) return false
        if (current.role !== role) user.value = { ...current, role }
        return true
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
        recovery,
        setRecovery,
        staffMfaRefusal,
        setStaffMfaRefusal,
        markAnonymous,
        setUser,
        setInitUser,
        applyProfile,
        clearUser,
        hasUser,
        can,
        isStaff,
        applyAccessChanged,
        beginAccessRead,
        applyAccessRead,
        resetReady,
        markReady,
    }
})
