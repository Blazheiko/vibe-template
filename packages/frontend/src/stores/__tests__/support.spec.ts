import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getChatHistory = vi.fn()

vi.mock('@/utils/api', () => ({
    supportApi: { getChatHistory, deleteChatHistory: vi.fn() },
}))

const history = (...items: ['user' | 'assistant', string][]) =>
    items.map(([role, content], i) => ({
        id: String(i + 1),
        role,
        content,
        screenshots: null,
        createdAt: '2026-11-01T10:00:00.000Z',
    }))

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

describe('support store: was the message delivered?', () => {
    it('is delivered when the history now holds one more such message', async () => {
        const store = await freshStore()
        store.addUserMessage('hello')
        getChatHistory.mockResolvedValue(history(['user', 'hello']))

        expect(await store.confirmDelivery('hello', 0)).toBe(true)
        expect(store.messages.map((m) => m.content)).toEqual(['hello'])
    })

    it('is not delivered when the history has no new such message', async () => {
        const store = await freshStore()
        store.addUserMessage('hello')
        getChatHistory.mockResolvedValue(history(['assistant', 'Welcome!']))

        expect(await store.confirmDelivery('hello', 0)).toBe(false)
        // The history is the truth: the message that never arrived is gone from the list.
        expect(store.messages.map((m) => m.content)).toEqual(['Welcome!'])
    })

    it('does not mistake an earlier identical message for the new one', async () => {
        const store = await freshStore()
        getChatHistory.mockResolvedValue(history(['user', 'hi'], ['assistant', 'Hello!']))
        store.messages = history(['user', 'hi'], ['assistant', 'Hello!'])
        const before = store.messages.filter((m) => m.role === 'user' && m.content === 'hi').length
        store.addUserMessage('hi')

        expect(await store.confirmDelivery('hi', before)).toBe(false)
    })

    it('is unknown when the history cannot be read', async () => {
        const store = await freshStore()
        store.addUserMessage('hello')
        getChatHistory.mockRejectedValue(new Error('offline'))

        expect(await store.confirmDelivery('hello', 0)).toBeNull()
        // Nothing is thrown away on a guess.
        expect(store.messages.map((m) => m.content)).toEqual(['hello'])
    })

    it('is unknown when an empty history comes back for a conversation that has messages', async () => {
        // getChatHistory answers [] for a failed request as well as for a real empty history.
        const store = await freshStore()
        store.addUserMessage('hello')
        getChatHistory.mockResolvedValue([])

        expect(await store.confirmDelivery('hello', 0)).toBeNull()
        expect(store.messages).toHaveLength(1)
    })
})
