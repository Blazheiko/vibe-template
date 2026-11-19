import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { SessionView } from 'shared'
import { accountApi } from '@/utils/api'
import { useEventBus } from '@/utils/event-bus'
import { useWebSocketConnection } from '@/composables/useWebSocketConnection'

/**
 * The active sessions of the account page (feat-233, Р7–Р12): the current one apart, pages of the
 * others with "show more", ending one or all others. The list is read again on
 * `user_sessions_changed` (a sign-in, an ended session, a socket opened or closed) and on every
 * `ws_ready`, since the event bus does not replay; events close together are read once (300 ms).
 */

export type SessionsError = 'load' | 'unavailable' | null
export type SessionsNotice =
    'ended' | 'endedOthers' | 'endedOthersSignIn' | 'errorEnd' | 'tryAgain' | null

export const REFRESH_COALESCE_MS = 300

export function useActiveSessions(options: { coalesceMs?: number } = {}) {
    const eventBus = useEventBus()
    const { websocketOpen, suspendReconnect, resumeReconnect } = useWebSocketConnection()

    const current = ref<SessionView | null>(null)
    const others = ref<SessionView[]>([])
    const nextCursor = ref<string | null>(null)
    const loading = ref(false)
    const loadingMore = ref(false)
    const loaded = ref(false)
    const error = ref<SessionsError>(null)
    const notice = ref<SessionsNotice>(null)
    /** Sessions whose "end" is in flight: their button is disabled. */
    const ending = ref<ReadonlySet<string>>(new Set())
    const endingOthers = ref(false)

    // A newer read wins: an older answer that comes later is dropped.
    let generation = 0

    const failureOf = (transportCode: number): SessionsError =>
        transportCode === 503 ? 'unavailable' : 'load'

    const append = (page: readonly SessionView[]): void => {
        const seen = new Set(others.value.map((s) => s.id))
        if (current.value !== null) seen.add(current.value.id)
        const added = page.filter((s) => !seen.has(s.id))
        others.value = [...others.value, ...added]
    }

    /** The first page again; "show more" starts over. */
    const load = async (): Promise<void> => {
        generation += 1
        const mine = generation
        loading.value = true
        try {
            const { data, error: failure } = await accountApi.listSessions()
            if (mine !== generation) return
            if (failure !== null || data?.status !== 'success') {
                error.value = failureOf(failure?.transportCode ?? 0)
                return
            }
            error.value = null
            current.value = data.current
            others.value = []
            append(data.others)
            nextCursor.value = data.nextCursor
            loaded.value = true
        } finally {
            if (mine === generation) loading.value = false
        }
    }

    /** The next page; an empty page with a cursor keeps "show more" (Р7). */
    const loadMore = async (): Promise<void> => {
        const cursor = nextCursor.value
        if (cursor === null || loadingMore.value) return
        const mine = generation
        loadingMore.value = true
        try {
            const { data, error: failure } = await accountApi.listSessions(cursor)
            if (mine !== generation) return
            if (failure !== null || data?.status !== 'success') {
                error.value = failureOf(failure?.transportCode ?? 0)
                return
            }
            append(data.others)
            nextCursor.value = data.nextCursor
        } finally {
            loadingMore.value = false
        }
    }

    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const refreshSoon = (): void => {
        if (refreshTimer !== undefined) clearTimeout(refreshTimer)
        refreshTimer = setTimeout(() => {
            refreshTimer = undefined
            void load()
        }, options.coalesceMs ?? REFRESH_COALESCE_MS)
    }

    const setEnding = (id: string, on: boolean): void => {
        const next = new Set(ending.value)
        if (on) next.add(id)
        else next.delete(id)
        ending.value = next
    }

    /** Ends another session. A 404 means it is gone already: done all the same. */
    const revoke = async (id: string): Promise<boolean> => {
        if (ending.value.has(id)) return false
        setEnding(id, true)
        notice.value = null
        try {
            const { data, error: failure } = await accountApi.revokeSession(id)
            const gone = failure?.transportCode === 404
            if (!gone && (failure !== null || data?.status !== 'success')) {
                notice.value = failure?.clientCode === 'session_renewed' ? 'tryAgain' : 'errorEnd'
                return false
            }
            others.value = others.value.filter((s) => s.id !== id)
            notice.value = 'ended'
            return true
        } finally {
            setEnding(id, false)
        }
    }

    /**
     * Ends every other session. This session is renewed: the CSRF token is replaced by the API
     * layer and the socket by a new one, as after a password change. Without a renewal the user
     * signs in again.
     */
    const revokeOthers = async (): Promise<boolean> => {
        if (endingOthers.value) return false
        endingOthers.value = true
        notice.value = null
        // The answer brings the renewed session; a token refresh started meanwhile by a closed
        // socket would go out with the old cookie and sign the user out (feat-221).
        suspendReconnect()
        try {
            const { data, error: failure } = await accountApi.revokeOtherSessions()
            if (failure !== null || data?.status !== 'success') {
                notice.value = failure?.clientCode === 'session_renewed' ? 'tryAgain' : 'errorEnd'
                return false
            }
            if (data.sessionRenewed) {
                websocketOpen(data.wsUrl, data.wsToken)
                others.value = []
                nextCursor.value = null
                notice.value = 'endedOthers'
                void load()
            } else {
                notice.value = 'endedOthersSignIn'
                // The session may be gone: the app reads it again and goes to the sign-in page.
                eventBus.emit('init_app')
            }
            return true
        } finally {
            resumeReconnect()
            endingOthers.value = false
        }
    }

    const onChanged = (): void => {
        refreshSoon()
    }

    onMounted(() => {
        eventBus.on('user_sessions_changed', onChanged)
        eventBus.on('ws_ready', onChanged)
        void load()
    })
    onBeforeUnmount(() => {
        eventBus.off('user_sessions_changed', onChanged)
        eventBus.off('ws_ready', onChanged)
        if (refreshTimer !== undefined) clearTimeout(refreshTimer)
        generation += 1
    })

    return {
        current,
        others,
        nextCursor,
        loading,
        loadingMore,
        loaded,
        error,
        notice,
        ending,
        endingOthers,
        load,
        loadMore,
        revoke,
        revokeOthers,
    }
}
