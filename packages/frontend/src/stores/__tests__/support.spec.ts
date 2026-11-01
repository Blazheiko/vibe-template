import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getChatHistory = vi.fn()

vi.mock('@/utils/api', () => ({
    supportApi: { getChatHistory, deleteChatHistory: vi.fn() },
}))

const msg = (id: number, content = `m${String(id)}`) => ({
    id: String(id),
    role: id % 2 === 1 ? ('user' as const) : ('assistant' as const),
    content,
    screenshots: null,
    createdAt: '2026-11-01T10:00:00.000Z',
})
const page = (ids: number[], hasMore: boolean) => ({ messages: ids.map((id) => msg(id)), hasMore })

async function freshStore() {
    setActivePinia(createPinia())
    const { useSupportStore } = await import('../support')
    return useSupportStore()
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-01T10:00:00.000Z'))
})

afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    vi.clearAllMocks()
})

describe('support store: the optimistic message', () => {
    it('gives every message its own id, even within one millisecond', async () => {
        const store = await freshStore()

        const first = store.addUserMessage('a')
        store.completeStreaming('greeting')
        const second = store.addUserMessage('b')

        const ids = store.messages.map((m) => m.id)
        expect(new Set(ids).size).toBe(ids.length)
        expect(first).not.toBe(second)
    })

    // Review of feat-063: the greeting finishes after the user's message was added and
    // before the refusal arrives, so the user's message is no longer the last one.
    it('takes back the rejected message even when the greeting completed after it', async () => {
        const store = await freshStore()
        const id = store.addUserMessage('hello')
        store.completeStreaming('Welcome! How can I help?')

        store.removeMessage(id)

        expect(store.messages.map((m) => m.content)).toEqual(['Welcome! How can I help?'])
    })

    it('takes back only the message it was given', async () => {
        const store = await freshStore()
        store.addUserMessage('earlier')
        const id = store.addUserMessage('rejected')

        store.removeMessage(id)

        expect(store.messages.map((m) => m.content)).toEqual(['earlier'])
    })

    it('ignores an id that is no longer there', async () => {
        const store = await freshStore()
        store.addUserMessage('kept')

        store.removeMessage('nope')

        expect(store.messages).toHaveLength(1)
    })
})

// feat-063, D3: the history arrives a page at a time; "show earlier" fetches the page before
// the oldest message the server has sent, and the list never holds a message twice.
describe('support store: the history in pages', () => {
    it('loads the latest page and remembers whether older messages exist', async () => {
        const store = await freshStore()
        getChatHistory.mockResolvedValue(page([8, 9, 10], true))

        await store.loadHistory()

        expect(store.messages.map((m) => m.id)).toEqual(['8', '9', '10'])
        expect(store.hasMoreHistory).toBe(true)
    })

    it('shows earlier messages: fetches before the oldest one it has and puts them in front', async () => {
        const store = await freshStore()
        getChatHistory.mockResolvedValueOnce(page([8, 9, 10], true))
        await store.loadHistory()
        getChatHistory.mockResolvedValueOnce(page([5, 6, 7], false))

        const added = await store.loadEarlier()

        expect(getChatHistory).toHaveBeenLastCalledWith({ before: '8' })
        expect(store.messages.map((m) => m.id)).toEqual(['5', '6', '7', '8', '9', '10'])
        expect(store.hasMoreHistory).toBe(false)
        expect(added).toBe(3)
    })

    it('does not add a message it already has', async () => {
        const store = await freshStore()
        getChatHistory.mockResolvedValueOnce(page([8, 9, 10], true))
        await store.loadHistory()
        getChatHistory.mockResolvedValueOnce(page([7, 8], false))

        const added = await store.loadEarlier()

        expect(store.messages.map((m) => m.id)).toEqual(['7', '8', '9', '10'])
        expect(added).toBe(1)
    })

    it('takes the oldest message of the server, not one added here and not yet stored', async () => {
        const store = await freshStore()
        getChatHistory.mockResolvedValueOnce(page([8, 9, 10], true))
        await store.loadHistory()
        // A message of this session, in front of the server's (e.g. a greeting that arrived
        // before the history did): it has no server id, so it cannot be the cursor.
        store.completeStreaming('Welcome!')
        store.messages = [...store.messages.slice(-1), ...store.messages.slice(0, -1)]
        store.addUserMessage('typed just now')
        getChatHistory.mockResolvedValueOnce(page([6, 7], true))

        await store.loadEarlier()

        expect(getChatHistory).toHaveBeenLastCalledWith({ before: '8' })
        expect(store.messages.map((m) => m.id)).toEqual([
            '6',
            '7',
            'local-1',
            '8',
            '9',
            '10',
            'local-2',
        ])
    })

    it('does nothing when there is nothing earlier', async () => {
        const store = await freshStore()
        getChatHistory.mockResolvedValueOnce(page([1, 2], false))
        await store.loadHistory()
        getChatHistory.mockClear()

        expect(await store.loadEarlier()).toBe(0)
        expect(getChatHistory).not.toHaveBeenCalled()
    })

    it('asks for one page at a time', async () => {
        const store = await freshStore()
        getChatHistory.mockResolvedValueOnce(page([8, 9, 10], true))
        await store.loadHistory()
        let finish: (value: ReturnType<typeof page>) => void = () => undefined
        getChatHistory.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))

        const first = store.loadEarlier()
        const second = await store.loadEarlier()
        finish(page([5, 6, 7], false))
        await first

        expect(second).toBe(0)
        expect(getChatHistory).toHaveBeenCalledTimes(2) // the latest page, and one earlier
        expect(store.isLoadingEarlier).toBe(false)
    })

    it('keeps what it has and shows an error when the earlier page cannot be read', async () => {
        const store = await freshStore()
        getChatHistory.mockResolvedValueOnce(page([8, 9, 10], true))
        await store.loadHistory()
        getChatHistory.mockResolvedValueOnce(null)

        expect(await store.loadEarlier()).toBe(0)

        expect(store.messages.map((m) => m.id)).toEqual(['8', '9', '10'])
        expect(store.hasMoreHistory).toBe(true)
        expect(store.error).not.toBeNull()
        expect(store.isLoadingEarlier).toBe(false)
    })

    it('does not wipe the conversation when the latest page cannot be read', async () => {
        const store = await freshStore()
        getChatHistory.mockResolvedValueOnce(page([8, 9, 10], false))
        await store.loadHistory()
        getChatHistory.mockResolvedValueOnce(null)

        await store.loadHistory()

        expect(store.messages.map((m) => m.id)).toEqual(['8', '9', '10'])
        expect(store.error).not.toBeNull()
    })

    it('forgets the pages on reset', async () => {
        const store = await freshStore()
        getChatHistory.mockResolvedValueOnce(page([8, 9, 10], true))
        await store.loadHistory()

        store.reset()

        expect(store.hasMoreHistory).toBe(false)
        expect(store.messages).toEqual([])
    })
})
