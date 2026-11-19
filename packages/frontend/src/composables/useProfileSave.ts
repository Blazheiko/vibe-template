import { computed, reactive, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { Profile, ProfilePreferences } from 'shared'
import type { UpdateProfileInput } from 'shared/schemas'
import { accountApi } from '@/utils/api'
import { useUserStore } from '@/stores/user'
import { useStateStore } from '@/stores/state'
import { useEventBus } from '@/utils/event-bus'
import {
    getErrorCode,
    getErrorReason,
    getResponseMessage,
    getResponseMessages,
    hasResponseError,
} from '@/utils/response-normalizer'

/**
 * The save queue of the profile (feat-232, Р10, Р11): one per tab.
 *
 * Two layers: the **confirmed** profile (the last server snapshot applied, `userStore.profile`)
 * and the **pending** changes (fields the user changed that no answer has confirmed yet). The
 * page shows the confirmed profile with the pending changes on top. One PATCH at a time carries
 * the pending fields; changes made meanwhile merge (the last value of each field wins) and go in
 * the next PATCH. An answer clears from the pending layer only the fields that still hold the
 * value it sent, so a newer choice is never lost: sent `dark`, chose `light`, `dark` succeeded —
 * the page stays light and `light` goes next.
 *
 * The queue belongs to the account it was made for. A sign-out, another account or a 401 ends
 * it: the timer stops, the pending changes are dropped and the answer of a request still under
 * way is ignored. No PATCH carries one account's changes for another.
 */

export type ProfileChanges = UpdateProfileInput

export type SaveFailureKind = 'rate_limited' | 'validation' | 'unauthorized' | 'error'

export type SaveOutcome =
    | { status: 'saved'; profile: Profile }
    | {
          status: 'failed'
          kind: SaveFailureKind
          message: string
          messages: string[]
          reason: string | undefined
      }
    /** Not sent, or its answer ignored: the account changed or the queue stopped. */
    | { status: 'dropped' }

export type SendResult =
    | { ok: true; profile: Profile }
    | {
          ok: false
          kind: SaveFailureKind
          message: string
          messages?: string[]
          reason?: string | undefined
      }

export interface ProfileSaveDeps {
    send(body: ProfileChanges): Promise<SendResult>
    applyProfile(profile: Profile): void
    currentUserId(): string | null
    confirmed(): Profile | null
}

type Field = keyof ProfileChanges
type Waiter = (outcome: SaveOutcome) => void

export interface ProfileSaveQueue {
    /** Adds changes; they go after `delayMs` (0: at once), or after the request under way. */
    change(fields: ProfileChanges, options?: { delayMs?: number }): Promise<SaveOutcome>
    /** Ends the queue of the current account and starts one for `ownerId` (null: none). */
    reset(ownerId: string | null): void
    readonly pending: Readonly<ProfileChanges>
    /** The confirmed profile with the pending changes on top; null before the first snapshot. */
    readonly shown: ComputedRef<Profile | null>
    readonly saving: Ref<boolean>
    readonly lastFailure: Ref<Extract<SaveOutcome, { status: 'failed' }> | null>
    readonly ownerId: () => string | null
}

const isEmpty = (changes: ProfileChanges): boolean => Object.keys(changes).length === 0

export function createProfileSaveQueue(deps: ProfileSaveDeps): ProfileSaveQueue {
    const pending = reactive<Record<string, unknown>>({})
    const saving = ref(false)
    const lastFailure = ref<Extract<SaveOutcome, { status: 'failed' }> | null>(null)
    let owner: string | null = deps.currentUserId()
    /** Bumped when the queue ends: an answer of an older epoch is ignored. */
    let epoch = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let inFlight = false
    let waiting: Waiter[] = []

    const clearTimer = () => {
        if (timer !== null) clearTimeout(timer)
        timer = null
    }

    const settle = (waiters: Waiter[], outcome: SaveOutcome) => {
        for (const waiter of waiters) waiter(outcome)
    }

    const dropPending = () => {
        for (const key of Object.keys(pending)) Reflect.deleteProperty(pending, key)
    }

    function reset(ownerId: string | null) {
        epoch += 1
        clearTimer()
        dropPending()
        inFlight = false
        saving.value = false
        lastFailure.value = null
        settle(waiting, { status: 'dropped' })
        waiting = []
        owner = ownerId
    }

    const schedule = (delayMs: number) => {
        clearTimer()
        if (delayMs <= 0) {
            void flush()
            return
        }
        timer = setTimeout(() => {
            timer = null
            void flush()
        }, delayMs)
    }

    async function flush(): Promise<void> {
        if (inFlight) return // goes after the answer
        const sent = { ...pending } as ProfileChanges
        if (isEmpty(sent)) return
        if (owner === null || owner !== deps.currentUserId()) {
            // Another account by now: these changes are not theirs.
            reset(deps.currentUserId())
            return
        }

        const myEpoch = epoch
        const waiters = waiting
        waiting = []
        inFlight = true
        saving.value = true

        let result: SendResult
        try {
            result = await deps.send(sent)
        } catch (error) {
            result = { ok: false, kind: 'error', message: String(error) }
        }

        if (myEpoch !== epoch) {
            // The account changed while the request was under way: its answer is not for us.
            settle(waiters, { status: 'dropped' })
            return
        }
        inFlight = false
        saving.value = false

        // Only the fields that still hold the value this request sent: a change made after it
        // was sent stays pending and goes next, whatever the answer.
        for (const key of Object.keys(sent) as Field[]) {
            if (key in pending && Object.is(pending[key], sent[key])) {
                Reflect.deleteProperty(pending, key)
            }
        }

        let outcome: SaveOutcome
        if (result.ok) {
            deps.applyProfile(result.profile)
            lastFailure.value = null
            outcome = { status: 'saved', profile: result.profile }
        } else {
            const failure = {
                status: 'failed' as const,
                kind: result.kind,
                message: result.message,
                messages: result.messages ?? [],
                reason: result.reason,
            }
            lastFailure.value = failure
            outcome = failure
        }
        settle(waiters, outcome)

        if (!result.ok && result.kind === 'unauthorized') {
            // The session is gone: nothing more is sent from this queue.
            reset(null)
            return
        }
        if (!isEmpty(pending) && timer === null) void flush()
    }

    function change(fields: ProfileChanges, options: { delayMs?: number } = {}) {
        if (owner === null || owner !== deps.currentUserId()) {
            return Promise.resolve<SaveOutcome>({ status: 'dropped' })
        }
        Object.assign(pending, fields)
        const outcome = new Promise<SaveOutcome>((resolve) => {
            waiting.push(resolve)
        })
        schedule(options.delayMs ?? 0)
        return outcome
    }

    const shown = computed<Profile | null>(() => {
        const confirmed = deps.confirmed()
        if (confirmed === null) return null
        const overlay = pending as ProfileChanges
        const preferences: ProfilePreferences = { ...confirmed.preferences }
        for (const key of Object.keys(preferences) as (keyof ProfilePreferences)[]) {
            if (key in overlay) (preferences as Record<string, unknown>)[key] = overlay[key]
        }
        return {
            name: overlay.name ?? confirmed.name,
            preferences,
            revision: confirmed.revision,
        }
    })

    return {
        change,
        reset,
        pending: pending,
        shown,
        saving,
        lastFailure,
        ownerId: () => owner,
    }
}

/** What an answer of PATCH /account/profile means for the queue. */
export async function sendProfileChanges(body: ProfileChanges): Promise<SendResult> {
    const { data, error } = await accountApi.updateProfile(body)
    if (error === null && data !== null && !hasResponseError(data) && data.status === 'success') {
        return { ok: true, profile: data.profile }
    }
    const message = getResponseMessage(data ?? error, error?.message ?? 'Could not save')
    const code = getErrorCode(data) ?? error?.code
    const transport = error?.transportCode ?? 0
    const kind: SaveFailureKind =
        code === 'rate_limited' || transport === 429
            ? 'rate_limited'
            : code === 'unauthorized' || transport === 401
              ? 'unauthorized'
              : code === 'validation_failed' || code === 'bad_request' || transport === 422
                ? 'validation'
                : 'error'
    const messages = getResponseMessages(data)
    return {
        ok: false,
        kind,
        message,
        messages: Array.isArray(messages) ? messages.map(String) : [],
        reason: getErrorReason(data),
    }
}

let tabQueue: ProfileSaveQueue | null = null

/** The queue of this tab, bound to the user store and the API. */
export function useProfileSave(): ProfileSaveQueue {
    if (tabQueue === null) {
        const userStore = useUserStore()
        tabQueue = createProfileSaveQueue({
            send: sendProfileChanges,
            applyProfile: (profile) => {
                userStore.applyProfile(profile)
            },
            currentUserId: () => userStore.user?.id ?? null,
            confirmed: () => userStore.profile,
        })
    }
    return tabQueue
}

/** Test seam: forget the queue of this tab. */
export function resetProfileSaveForTests(): void {
    tabQueue = null
}

export interface ProfileLiveSyncDeps {
    applyProfile(profile: Profile): void
    currentUserId(): string | null
    fetchProfile(): Promise<Profile | null>
}

/**
 * Live sync (feat-232, Р9 B). `user_profile_updated` comes to every connection of the user, this
 * tab included; it is applied as any snapshot, by revision, under the pending changes. Events are
 * not replayed, and one sent between the init snapshot and the registration of a socket reaches
 * nobody here, so the profile is read again after every connection, the first one included
 * (review 2026-11-19, item 4). An answer that arrives after the account changed is dropped.
 */
export function createProfileLiveSync(deps: ProfileLiveSyncDeps) {
    return {
        onProfileEvent(profile: Profile): void {
            if (deps.currentUserId() === null) return
            deps.applyProfile(profile)
        },
        async onConnected(): Promise<void> {
            const userId = deps.currentUserId()
            if (userId === null) return
            const profile = await deps.fetchProfile()
            if (profile !== null && deps.currentUserId() === userId) deps.applyProfile(profile)
        },
    }
}

async function fetchProfile(): Promise<Profile | null> {
    const { data, error } = await accountApi.getProfile()
    if (error !== null || data === null || hasResponseError(data) || data.status !== 'success') {
        return null
    }
    return data.profile
}

/**
 * Called once by App.vue: ends the queue when the account changes and shows the preferences of
 * whoever is signed in (the device's own when nobody is).
 */
export function useProfileSync(): void {
    const userStore = useUserStore()
    const stateStore = useStateStore()
    const queue = useProfileSave()

    // Review 2026-11-19, item 5: before init answers, nobody is signed in only because the
    // session is not checked yet. The cached look of the last account stays until then; the
    // device's own shows once the session is known to be anonymous.
    watch(
        () => [userStore.user?.id ?? null, userStore.anonymousConfirmed] as const,
        ([userId, anonymous]) => {
            if (queue.ownerId() !== userId) queue.reset(userId)
            if (userId !== null) stateStore.showAccountFromCache(userId)
            else if (anonymous) stateStore.showDevicePreferences()
        },
        { immediate: true },
    )

    const live = createProfileLiveSync({
        applyProfile: (profile) => {
            userStore.applyProfile(profile)
        },
        currentUserId: () => userStore.user?.id ?? null,
        fetchProfile,
    })
    const eventBus = useEventBus()
    eventBus.on('user_profile_updated', (profile) => {
        live.onProfileEvent(profile)
    })
    eventBus.on('ws_connected', () => {
        void live.onConnected()
    })

    watch(
        () => queue.shown.value,
        (profile) => {
            const userId = userStore.user?.id
            if (profile === null || userId === undefined) return
            stateStore.showAccountPreferences(userId, profile.preferences)
        },
        { deep: true, immediate: true },
    )
}
