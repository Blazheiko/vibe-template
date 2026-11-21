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
/** The first page of the history page. */
export const NOTIFICATIONS_FIRST_PAGE = 20
/** The latest notifications the bell panel shows. */
export const NOTIFICATIONS_PANEL_SIZE = 10

/** Where a list is shown: the history page (with its filter and pages) or the bell panel. */
export type NotificationListView = 'page' | 'panel'

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
    /** The bell panel: always the latest notifications, never filtered (feat-237). */
    const panelItems = ref<NotificationItem[]>([])
    const panelLoaded = ref(false)
    const panelFailed = ref(false)
    /** How many pages and panels show their list now; each is read while above 0. */
    const pageOpen = ref(0)
    const panelOpen = ref(0)
    const unreadOnly = ref(false)

    const badge = computed(() =>
        unreadCount.value >= NOTIFICATIONS_UNREAD_COUNT_CAP ? '99+' : String(unreadCount.value),
    )

    let generation = 0
    let seq = 0
    let appliedSeq = 0
    let pageSeq = 0
    let panelSeq = 0
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
    const applyCount = (mine: { generation: number; seq: number }, value: number): void => {
        if (fresh(mine)) unreadCount.value = value
    }

    const readPage = async (): Promise<void> => {
        const mine = ticket()
        const { data, error } = await notificationsApi.list({
            unread: unreadOnly.value,
            limit: NOTIFICATIONS_FIRST_PAGE,
        })
        if (mine.generation !== generation) return
        if (error !== null || data?.status !== 'success') {
            loadFailed.value = true
            return
        }
        applyCount(mine, data.unreadCount)
        if (mine.seq <= pageSeq) return
        pageSeq = mine.seq
        items.value = data.items
        next.value = data.next
        loaded.value = true
        loadFailed.value = false
    }

    const readPanel = async (): Promise<void> => {
        const mine = ticket()
        const { data, error } = await notificationsApi.list({ limit: NOTIFICATIONS_PANEL_SIZE })
        if (mine.generation !== generation) return
        if (error !== null || data?.status !== 'success') {
            panelFailed.value = true
            return
        }
        applyCount(mine, data.unreadCount)
        if (mine.seq <= panelSeq) return
        panelSeq = mine.seq
        panelItems.value = data.items
        panelLoaded.value = true
        panelFailed.value = false
    }

    /**
     * What a read covers (feat-238): the count always; the first page of the history and the
     * panel only when asked for and open. Opening the panel reads the panel alone, so the pages
     * the history has loaded and its cursor stay.
     */
    interface ReadScope {
        page: boolean
        panel: boolean
    }
    const ALL: ReadScope = { page: true, panel: true }
    let pending: ReadScope = { page: false, panel: false }
    const ask = (scope: Partial<ReadScope>): void => {
        pending = {
            page: pending.page || scope.page === true,
            panel: pending.panel || scope.panel === true,
        }
    }

    /** The count, and the first page of each list asked for and open now (Р11). */
    const readOnce = async (scope: ReadScope): Promise<void> => {
        const page = scope.page && pageOpen.value > 0
        const panel = scope.panel && panelOpen.value > 0
        if (!page && !panel) {
            const mine = ticket()
            const { data, error } = await notificationsApi.unreadCount()
            if (error !== null || data?.status !== 'success') return
            applyCount(mine, data.unreadCount)
            return
        }
        if (page) await readPage()
        if (panel) await readPanel()
    }

    // Read through a function: `dirty` changes while a read is awaited.
    const askedAgain = (): boolean => dirty

    /** Reads now; asked again while a read is in flight, reads once more after it. */
    const readNow = async (scope: Partial<ReadScope> = ALL): Promise<void> => {
        ask(scope)
        if (!userStore.hasUser()) return
        if (inFlight) {
            dirty = true
            return
        }
        inFlight = true
        try {
            // Not bound to the account it started for: a read asked for the next account while one
            // of the previous account was in flight runs here, for the account of now (feat-237).
            do {
                dirty = false
                const taken = pending
                pending = { page: false, panel: false }
                await readOnce(taken)
            } while (askedAgain() && userStore.hasUser())
        } finally {
            inFlight = false
        }
    }

    /** Joins the reads asked for within the window into one, covering all their scopes. */
    const refreshSoon = (scope: Partial<ReadScope> = ALL): void => {
        ask(scope)
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => {
            timer = undefined
            void readNow({})
        }, NOTIFICATIONS_REFRESH_COALESCE_MS)
    }
    // A handler of the bus gets the event's payload: never take it for a scope.
    const refreshAll = (): void => {
        refreshSoon(ALL)
    }

    /** A page or panel that shows its list mounts (Р11); every open has exactly one close. */
    const openList = (view: NotificationListView): void => {
        if (view === 'page') pageOpen.value += 1
        else panelOpen.value += 1
        refreshSoon({ [view]: true })
    }
    const closeList = (view: NotificationListView): void => {
        if (view === 'page') pageOpen.value = Math.max(0, pageOpen.value - 1)
        else panelOpen.value = Math.max(0, panelOpen.value - 1)
    }

    const setUnreadOnly = (value: boolean): void => {
        if (unreadOnly.value === value) return
        unreadOnly.value = value
        items.value = []
        next.value = null
        loaded.value = false
        pageSeq = seq
        void readNow({ page: true })
    }

    const loadMore = async (): Promise<void> => {
        const cursor = next.value
        if (cursor === null || loadingMore.value) return
        const mine = ticket()
        loadingMore.value = true
        try {
            const { data, error } = await notificationsApi.list({
                unread: unreadOnly.value,
                before: cursor,
                limit: NOTIFICATIONS_FIRST_PAGE,
            })
            // The list was read again meanwhile: this page continues an older one. A mark-read or
            // read-all that ended after this page was asked for may leave the cursor as it was, so
            // the cursor alone does not tell; pageSeq does (feat-239).
            if (mine.generation !== generation || mine.seq <= pageSeq || next.value !== cursor) {
                return
            }
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

    /**
     * After a successful mark-read: every read that started before it may carry the old `readAt`,
     * so their list answers are dropped (feat-238); the read after the mutation brings the rest.
     */
    const markLocallyRead = (ids: (id: string) => boolean): void => {
        pageSeq = Math.max(pageSeq, seq)
        panelSeq = Math.max(panelSeq, seq)
        const now = new Date().toISOString()
        const mark = (list: NotificationItem[]): NotificationItem[] =>
            list.map((item) =>
                item.readAt === null && ids(item.id) ? { ...item, readAt: now } : item,
            )
        items.value = mark(items.value)
        panelItems.value = mark(panelItems.value)
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
            applyCount(mine, data.unreadCount)
            return { kind: 'read', link: data.link }
        } finally {
            refreshSoon()
        }
    }

    /** "Mark all read": every notification up to the newest this view has shown (Р6). */
    const markAllRead = async (view: NotificationListView): Promise<boolean> => {
        const upTo = maxId(view === 'page' ? items.value : panelItems.value)
        if (upTo === null) return false
        const bound = BigInt(upTo)
        const mine = ticket()
        try {
            const { data, error } = await notificationsApi.readAll(upTo)
            if (error !== null || data?.status !== 'success') return false
            if (mine.generation === generation) markLocallyRead((id) => BigInt(id) <= bound)
            applyCount(mine, data.unreadCount)
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
        pending = { page: false, panel: false }
        unreadCount.value = 0
        items.value = []
        next.value = null
        loaded.value = false
        loadFailed.value = false
        panelItems.value = []
        panelLoaded.value = false
        panelFailed.value = false
        unreadOnly.value = false
        // pageOpen and panelOpen stay: they count the lists mounted now, which close themselves.
    }

    // Recovery points (Р8): the bus does not replay, and the retention job sends no signal.
    const onVisible = (): void => {
        if (document.visibilityState === 'visible') refreshAll()
    }
    eventBus.on('notifications_changed', refreshAll)
    eventBus.on('ws_ready', refreshAll)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
    onScopeDispose(() => {
        eventBus.off('notifications_changed', refreshAll)
        eventBus.off('ws_ready', refreshAll)
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
        panelItems,
        panelLoaded,
        panelFailed,
        pageOpen,
        panelOpen,
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
