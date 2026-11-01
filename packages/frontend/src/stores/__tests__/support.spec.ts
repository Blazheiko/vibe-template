import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/api', () => ({
    supportApi: { getChatHistory: vi.fn(), deleteChatHistory: vi.fn() },
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
