import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, watch } from 'vue'
import type { NotificationItem } from 'shared'
import { NOTIFICATIONS_UNREAD_COUNT_CAP } from 'shared/notifications'
import { notificationsApi } from '@/utils/api'
import { useEventBus } from '@/utils/event-bus'
import { useUserStore } from '@/stores/user'

/**
 * The notification center of the signed-in user (feat-236, Р8, Р11).
 *
 * The server's count is the only truth: a WS signal carries no value, it asks to read again. Reads
 * close together are joined (`refreshSoon`), and a read asked for while one is in flight runs once
 * more after it (`dirty`), so the last read always starts after the last change. A late answer of
 * an older request is dropped (`seq`), and so is any answer for the previous account
 * (`generation`).
 */

export const NOTIFICATIONS_REFRESH_COALESCE_MS = 300
/** The first page of the panel and of the history page. */
export const NOTIFICATIONS_FIRST_PAGE = 20

export type MarkReadOutcome =
    { kind: 'read'; link: string | null } | { kind: 'gone' } | { kind: 'error' }

const maxId = (items: readonly NotificationItem[]): string | null => {
    let best: bigint | null = null
    for (const item of items) {
        const id = BigInt(item.id)
        if (best === null || id > best) best = id
    }
    return best === null ? null : String(best)
}

export const useNotificationsStore = defineStore('notifications', () => {
    const eventBus = useEventBus()
    const userStore = useUserStore()

    const unreadCount = ref(0)
    const items = ref<NotificationItem[]>([])
    const next = ref<string | null>(null)
    const loaded = ref(false)
    const loadFailed = ref(false)
    const loadingMore = ref(false)
    /** How many panels and pages show the list now; the first page is read while above 0. */
    const listOpen = ref(0)
    const unreadOnly = ref(false)

    const badge = computed(() =>
        unreadCount.value >= NOTIFICATIONS_UNREAD_COUNT_CAP ? '99+' : String(unreadCount.value),
    )

    let generation = 0
    let seq = 0
    let appliedSeq = 0
    let inFlight = false
    let dirty = false
    let timer: ReturnType<typeof setTimeout> | undefined

    /** Applies an answer only for this account and only when no newer one was applied. */
    const fresh = (mine: { generation: number; seq: number }): boolean => {
        if (mine.generation !== generation || mine.seq <= appliedSeq) return false
        appliedSeq = mine.seq
        return true
    }
    const ticket = () => ({ generation, seq: ++seq })

    const readOnce = async (): Promise<void> => {
        const mine = ticket()
        if (listOpen.value > 0) {
            const { data, error } = await notificationsApi.list({
                unread: unreadOnly.value,
                limit: NOTIFICATIONS_FIRST_PAGE,
            })
            if (error !== null || data?.status !== 'success') {
                if (mine.generation === generation) loadFailed.value = true
                return
            }
            if (!fresh(mine)) return
            items.value = data.items
            next.value = data.next
            unreadCount.value = data.unreadCount
            loaded.value = true
            loadFailed.value = false
            return
        }
        const { data, error } = await notificationsApi.unreadCount()
        if (error !== null || data?.status !== 'success') return
        if (!fresh(mine)) return
        unreadCount.value = data.unreadCount
    }

    // Read through a function: `dirty` changes while a read is awaited.
    const askedAgain = (): boolean => dirty

    /** Reads now; asked again while a read is in flight, reads once more after it. */
    const readNow = async (): Promise<void> => {
        if (!userStore.hasUser()) return
        if (inFlight) {
            dirty = true
            return
        }
        inFlight = true
        const started = generation
        try {
            do {
                dirty = false
                await readOnce()
            } while (askedAgain() && started === generation && userStore.hasUser())
        } finally {
            inFlight = false
        }
    }

    const refreshSoon = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => {
            timer = undefined
            void readNow()
        }, NOTIFICATIONS_REFRESH_COALESCE_MS)
    }

    /** A panel or page that shows the list mounts (Р11); every open has exactly one close. */
    const openList = (): void => {
        listOpen.value += 1
        refreshSoon()
    }
    const closeList = (): void => {
        listOpen.value = Math.max(0, listOpen.value - 1)
    }

    const setUnreadOnly = (value: boolean): void => {
        if (unreadOnly.value === value) return
        unreadOnly.value = value
        items.value = []
        next.value = null
        loaded.value = false
        void readNow()
    }

    const loadMore = async (): Promise<void> => {
        const cursor = next.value
        if (cursor === null || loadingMore.value) return
        const started = generation
        loadingMore.value = true
        try {
            const { data, error } = await notificationsApi.list({
                unread: unreadOnly.value,
                before: cursor,
                limit: NOTIFICATIONS_FIRST_PAGE,
            })
            // The list was read again meanwhile: this page continues an older one.
            if (started !== generation || next.value !== cursor) return
            if (error !== null || data?.status !== 'success') {
                loadFailed.value = true
                return
            }
            const seen = new Set(items.value.map((item) => item.id))
            items.value = [...items.value, ...data.items.filter((item) => !seen.has(item.id))]
            next.value = data.next
        } finally {
            loadingMore.value = false
        }
    }

    const markLocallyRead = (ids: (id: string) => boolean): void => {
        const now = new Date().toISOString()
        items.value = items.value.map((item) =>
            item.readAt === null && ids(item.id) ? { ...item, readAt: now } : item,
        )
    }

    /**
     * Marks one notification read (Р6, Р7). A lost answer leaves the state unknown: nothing is
     * changed here, and the read again after it tells.
     */
    const markRead = async (id: string): Promise<MarkReadOutcome> => {
        const mine = ticket()
        try {
            const { data, error } = await notificationsApi.markRead(id)
            if (error?.transportCode === 404) return { kind: 'gone' }
            if (error !== null || data?.status !== 'success') return { kind: 'error' }
            if (mine.generation === generation) markLocallyRead((itemId) => itemId === id)
            if (fresh(mine)) unreadCount.value = data.unreadCount
            return { kind: 'read', link: data.link }
        } finally {
            refreshSoon()
        }
    }

    /** "Mark all read": every notification up to the newest this client has shown (Р6). */
    const markAllRead = async (): Promise<boolean> => {
        const upTo = maxId(items.value)
        if (upTo === null) return false
        const bound = BigInt(upTo)
        const mine = ticket()
        try {
            const { data, error } = await notificationsApi.readAll(upTo)
            if (error !== null || data?.status !== 'success') return false
            if (mine.generation === generation) markLocallyRead((id) => BigInt(id) <= bound)
            if (fresh(mine)) unreadCount.value = data.unreadCount
            return true
        } finally {
            refreshSoon()
        }
    }

    /** A sign-out or another account: everything of the previous one is dropped. */
    const reset = (): void => {
        generation += 1
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        dirty = false
        unreadCount.value = 0
        items.value = []
        next.value = null
        loaded.value = false
        loadFailed.value = false
        listOpen.value = 0
        unreadOnly.value = false
    }

    // Recovery points (Р8): the bus does not replay, and the retention job sends no signal.
    const onVisible = (): void => {
        if (document.visibilityState === 'visible') refreshSoon()
    }
    eventBus.on('notifications_changed', refreshSoon)
    eventBus.on('ws_ready', refreshSoon)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
    onScopeDispose(() => {
        eventBus.off('notifications_changed', refreshSoon)
        eventBus.off('ws_ready', refreshSoon)
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onVisible)
        }
        if (timer !== undefined) clearTimeout(timer)
    })
    watch(
        () => userStore.user?.id ?? null,
        (id, previous) => {
            if (id === previous) return
            reset()
            if (id !== null) refreshSoon()
        },
        { immediate: true },
    )

    return {
        unreadCount,
        badge,
        items,
        next,
        loaded,
        loadFailed,
        loadingMore,
        listOpen,
        unreadOnly,
        refreshSoon,
        readNow,
        openList,
        closeList,
        setUnreadOnly,
        loadMore,
        markRead,
        markAllRead,
        reset,
    }
})
