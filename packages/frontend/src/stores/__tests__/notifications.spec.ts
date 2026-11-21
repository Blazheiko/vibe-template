import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, ref } from 'vue'

// feat-236 (Р8, Р11): the unread count is the server's. A WS signal asks to read again, reads
// close together are joined, a read asked for during one in flight runs once more after it, a
// late answer of an older request and any answer for the previous account are dropped.

interface Deferred<T> {
    promise: Promise<T>
    resolve: (value: T) => void
}
const deferred = <T>(): Deferred<T> => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => {
        resolve = r
    })
    return { promise, resolve }
}
const ok = <T extends object>(data: T) => ({ data: { status: 'success', ...data }, error: null })

const api = vi.hoisted(() => ({
    list: vi.fn(),
    unreadCount: vi.fn(),
    markRead: vi.fn(),
    readAll: vi.fn(),
}))
vi.mock('@/utils/api', () => ({ notificationsApi: api }))

const user = ref<{ id: string } | null>({ id: '7' })
vi.mock('@/stores/user', () => ({
    useUserStore: () => ({
        get user() {
            return user.value
        },
        hasUser: () => user.value !== null,
    }),
}))

const { useNotificationsStore, NOTIFICATIONS_REFRESH_COALESCE_MS } =
    await import('../notifications')
const { useEventBus } = await import('@/utils/event-bus')

const item = (id: string, readAt: string | null = null) => ({
    id,
    kind: 'security.logout_all' as const,
    category: 'security' as const,
    params: {},
    link: '/account',
    createdAt: '2026-11-20T10:00:00.000Z',
    readAt,
})

const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await nextTick()
}
/** Lets the coalescing timer fire and the reads it starts settle. */
const tick = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(NOTIFICATIONS_REFRESH_COALESCE_MS)
    await flush()
}

beforeEach(() => {
    vi.useFakeTimers()
    user.value = { id: '7' }
    setActivePinia(createPinia())
    api.unreadCount.mockResolvedValue(ok({ unreadCount: 0 }))
    api.list.mockResolvedValue(ok({ items: [], next: null, unreadCount: 0 }))
})

afterEach(() => {
    useNotificationsStore().$dispose()
    useEventBus().all.clear()
    vi.clearAllMocks()
    vi.useRealTimers()
})

describe('notifications store', () => {
    it('reads the count once for several signals close together', async () => {
        const store = useNotificationsStore()
        await tick()
        api.unreadCount.mockClear()
        api.unreadCount.mockResolvedValue(ok({ unreadCount: 3 }))

        const bus = useEventBus()
        bus.emit('notifications_changed', {})
        bus.emit('notifications_changed', {})
        bus.emit('ws_ready')
        await tick()

        expect(api.unreadCount).toHaveBeenCalledOnce()
        expect(store.unreadCount).toBe(3)
        expect(store.badge).toBe('3')
    })

    it('a signal during a read in flight gives exactly one more read after it', async () => {
        const store = useNotificationsStore()
        await tick()
        api.unreadCount.mockClear()
        const first = deferred<ReturnType<typeof ok>>()
        api.unreadCount
            .mockReturnValueOnce(first.promise)
            .mockResolvedValueOnce(ok({ unreadCount: 5 }))

        void store.readNow()
        await flush()
        useEventBus().emit('notifications_changed', {})
        await vi.advanceTimersByTimeAsync(NOTIFICATIONS_REFRESH_COALESCE_MS)
        expect(api.unreadCount).toHaveBeenCalledTimes(1)

        first.resolve(ok({ unreadCount: 4 }))
        await flush()
        expect(api.unreadCount).toHaveBeenCalledTimes(2)
        expect(store.unreadCount).toBe(5)

        await tick()
        expect(api.unreadCount).toHaveBeenCalledTimes(2)
    })

    it('an older read answering after a newer read of "mark read" does not change the count', async () => {
        const store = useNotificationsStore()
        await tick()
        const read = deferred<ReturnType<typeof ok>>()
        api.unreadCount.mockReturnValueOnce(read.promise)
        api.markRead.mockResolvedValue(ok({ link: '/account', unreadCount: 1 }))

        void store.readNow()
        await flush()
        await store.markRead('9')
        expect(store.unreadCount).toBe(1)

        read.resolve(ok({ unreadCount: 2 }))
        await flush()
        expect(store.unreadCount).toBe(1)
    })

    it('two reads that commit in reverse order: the count ends as the server has it after both', async () => {
        const store = useNotificationsStore()
        await tick()
        api.unreadCount.mockClear()
        const a = deferred<ReturnType<typeof ok>>()
        const b = deferred<ReturnType<typeof ok>>()
        api.markRead.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)

        const readA = store.markRead('1')
        const readB = store.markRead('2')
        // The server commits B first (2 left), then A (1 left): A's answer has the newest count,
        // but A started first, so its answer is dropped as the older one.
        b.resolve(ok({ link: null, unreadCount: 2 }))
        await readB
        a.resolve(ok({ link: null, unreadCount: 1 }))
        await readA
        expect(store.unreadCount).toBe(2)

        // Both finished: one more read, started after both commits, gives the server's value.
        api.unreadCount.mockResolvedValue(ok({ unreadCount: 1 }))
        await tick()
        expect(api.unreadCount).toHaveBeenCalledOnce()
        expect(store.unreadCount).toBe(1)
    })

    it('a lost answer of "mark read" changes nothing locally and reads again', async () => {
        const store = useNotificationsStore()
        store.openList('page')
        api.list.mockResolvedValue(ok({ items: [item('5')], next: null, unreadCount: 1 }))
        await tick()
        api.list.mockClear()
        api.markRead.mockResolvedValue({ data: null, error: { transportCode: 0 } })

        await expect(store.markRead('5')).resolves.toEqual({ kind: 'error' })
        expect(store.items[0]?.readAt).toBeNull()
        expect(store.unreadCount).toBe(1)

        api.list.mockResolvedValue(
            ok({ items: [item('5', '2026-11-20T10:01:00.000Z')], next: null, unreadCount: 0 }),
        )
        await tick()
        expect(api.list).toHaveBeenCalledOnce()
        expect(store.unreadCount).toBe(0)
        expect(store.items[0]?.readAt).not.toBeNull()
    })

    it('"mark read" of a missing notification is gone', async () => {
        const store = useNotificationsStore()
        api.markRead.mockResolvedValue({ data: null, error: { transportCode: 404 } })
        await expect(store.markRead('5')).resolves.toEqual({ kind: 'gone' })
    })

    it('reads the first page only while a list is open; a missed signal is recovered', async () => {
        const store = useNotificationsStore()
        await tick()
        api.list.mockClear()
        api.unreadCount.mockClear()

        useEventBus().emit('ws_ready')
        await tick()
        expect(api.list).not.toHaveBeenCalled()
        expect(api.unreadCount).toHaveBeenCalledOnce()

        store.openList('page')
        api.list.mockResolvedValue(ok({ items: [item('3')], next: null, unreadCount: 1 }))
        await tick()
        expect(store.items.map((n) => n.id)).toEqual(['3'])

        // A signal was missed (the socket was down): ws_ready reads badge and list again.
        api.list.mockResolvedValue(
            ok({ items: [item('4'), item('3')], next: null, unreadCount: 2 }),
        )
        useEventBus().emit('ws_ready')
        await tick()
        expect(store.items.map((n) => n.id)).toEqual(['4', '3'])
        expect(store.unreadCount).toBe(2)

        // The tab shown again is a recovery point too.
        api.list.mockClear()
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
        await tick()
        expect(api.list).toHaveBeenCalledOnce()
    })

    it('openList and closeList pair; an extra close does not go below zero', () => {
        const store = useNotificationsStore()
        store.openList('page')
        store.openList('page')
        store.closeList('page')
        expect(store.pageOpen).toBe(1)
        store.closeList('page')
        store.closeList('page')
        expect(store.pageOpen).toBe(0)
        store.openList('panel')
        expect(store.panelOpen).toBe(1)
        expect(store.pageOpen).toBe(0)
        // A reset (another account) keeps the lists that are mounted: they close themselves.
        store.reset()
        expect(store.panelOpen).toBe(1)
    })

    it('"mark all read" sends the newest id shown and marks those shown read', async () => {
        const store = useNotificationsStore()
        store.openList('page')
        api.list.mockResolvedValue(
            ok({ items: [item('12'), item('9'), item('100')], next: null, unreadCount: 3 }),
        )
        await tick()
        api.readAll.mockResolvedValue(ok({ unreadCount: 0 }))

        await store.markAllRead('page')

        expect(api.readAll).toHaveBeenCalledWith('100')
        expect(store.items.every((n) => n.readAt !== null)).toBe(true)
        expect(store.unreadCount).toBe(0)
    })

    it('an answer for the previous account is dropped', async () => {
        const store = useNotificationsStore()
        await tick()
        const late = deferred<ReturnType<typeof ok>>()
        api.unreadCount.mockReturnValueOnce(late.promise)

        void store.readNow()
        await flush()
        user.value = { id: '8' }
        await flush()
        late.resolve(ok({ unreadCount: 42 }))
        await flush()

        expect(store.unreadCount).toBe(0)
    })

    // feat-237 (review of #732, 3): the read asked for the new account while one of the previous
    // account was in flight must still run once that one ends.
    it('after a switch during a read of the previous account, the new account is read', async () => {
        const store = useNotificationsStore()
        await tick()
        api.unreadCount.mockClear()
        const late = deferred<ReturnType<typeof ok>>()
        api.unreadCount
            .mockReturnValueOnce(late.promise)
            .mockResolvedValueOnce(ok({ unreadCount: 7 }))

        void store.readNow()
        await flush()
        user.value = { id: '8' }
        // The switch asks for a read; it fires while the read of account 7 is still in flight.
        await vi.advanceTimersByTimeAsync(NOTIFICATIONS_REFRESH_COALESCE_MS)
        expect(api.unreadCount).toHaveBeenCalledOnce()

        late.resolve(ok({ unreadCount: 42 }))
        await flush()

        expect(api.unreadCount).toHaveBeenCalledTimes(2)
        expect(store.unreadCount).toBe(7)
    })

    // feat-237 (review of #732, 4): the bell panel has its own list; the page keeps its filter.
    it('the panel reads the latest 10 unfiltered and leaves the page filter and items alone', async () => {
        const store = useNotificationsStore()
        store.openList('page')
        api.list.mockResolvedValue(ok({ items: [item('5')], next: '5', unreadCount: 1 }))
        await tick()
        store.setUnreadOnly(true)
        await flush()
        api.list.mockClear()
        api.list.mockImplementation((query: { unread?: boolean; limit?: number }) =>
            Promise.resolve(
                query.limit === 10
                    ? ok({
                          items: [item('9', '2026-11-20T10:01:00.000Z'), item('5')],
                          next: null,
                          unreadCount: 1,
                      })
                    : ok({ items: [item('5')], next: null, unreadCount: 1 }),
            ),
        )

        store.openList('panel')
        await tick()

        expect(store.unreadOnly).toBe(true)
        // feat-238: opening the panel reads the panel alone, not the history page.
        expect(api.list).toHaveBeenCalledExactlyOnceWith({ limit: 10 })
        expect(store.items.map((n) => n.id)).toEqual(['5'])
        expect(store.panelItems.map((n) => n.id)).toEqual(['9', '5'])

        api.readAll.mockResolvedValue(ok({ unreadCount: 0 }))
        await store.markAllRead('panel')
        expect(api.readAll).toHaveBeenCalledWith('9')
    })

    // feat-238 (re-review of #736, 1): the bell must not throw away the pages the history loaded.
    it('opening the panel keeps the second page of the history and its cursor', async () => {
        const store = useNotificationsStore()
        store.openList('page')
        api.list.mockResolvedValueOnce(
            ok({ items: [item('30'), item('29')], next: '29', unreadCount: 4 }),
        )
        await tick()
        api.list.mockResolvedValueOnce(
            ok({ items: [item('28'), item('27')], next: '27', unreadCount: 4 }),
        )
        await store.loadMore()
        expect(store.items.map((n) => n.id)).toEqual(['30', '29', '28', '27'])
        expect(store.next).toBe('27')

        api.list.mockClear()
        api.list.mockResolvedValue(ok({ items: [item('30')], next: null, unreadCount: 4 }))
        store.openList('panel')
        await tick()

        expect(api.list).toHaveBeenCalledExactlyOnceWith({ limit: 10 })
        expect(store.items.map((n) => n.id)).toEqual(['30', '29', '28', '27'])
        expect(store.next).toBe('27')
    })

    // feat-238 (re-review of #736, 2): a read that started before a successful mark-read must
    // not put the old readAt back into either list.
    it.each([
        ['mark read', (store: ReturnType<typeof useNotificationsStore>) => store.markRead('5')],
        [
            'mark all read',
            (store: ReturnType<typeof useNotificationsStore>) => store.markAllRead('page'),
        ],
    ])('a GET answering after a successful %s does not undo it', async (_label, mutate) => {
        const store = useNotificationsStore()
        store.openList('page')
        store.openList('panel')
        api.list.mockResolvedValue(ok({ items: [item('5')], next: null, unreadCount: 1 }))
        await tick()
        expect(store.items[0]?.readAt).toBeNull()

        // A read starts before the mutation and answers after it, with the old state.
        const late = deferred<ReturnType<typeof ok>>()
        const lateAnswer = ok({ items: [item('5')], next: null, unreadCount: 1 })
        api.list.mockReturnValueOnce(late.promise)
        void store.readNow()
        await flush()
        api.markRead.mockResolvedValue(ok({ link: '/account', unreadCount: 0 }))
        api.readAll.mockResolvedValue(ok({ unreadCount: 0 }))
        await mutate(store)
        // From now on the server has it read; only the late answer is old.
        api.list.mockResolvedValue(
            ok({ items: [item('5', '2026-11-21T10:00:00.000Z')], next: null, unreadCount: 0 }),
        )
        expect(store.items[0]?.readAt).not.toBeNull()
        expect(store.panelItems[0]?.readAt).not.toBeNull()

        late.resolve(lateAnswer)
        await flush()

        expect(store.items[0]?.readAt).not.toBeNull()
        expect(store.panelItems[0]?.readAt).not.toBeNull()
        expect(store.unreadCount).toBe(0)
    })

    it('caps the badge at 99+', async () => {
        const store = useNotificationsStore()
        api.unreadCount.mockResolvedValue(ok({ unreadCount: 100 }))
        await tick()
        expect(store.badge).toBe('99+')
    })
})
