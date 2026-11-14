import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import SupportView from '../SupportView.vue'
import en from '../../locales/en'
import { useSupportStore } from '@/stores/support'
import { useEventBus } from '@/utils/event-bus'

// feat-152 (review 2026-11-10, M11): the "answer in progress" state used to end only with the
// answer's own events. A dropped socket aborts the stream on the server, so no event comes;
// and leaving the page removes the listeners while the streamed text stays in the store.

const connection = vi.hoisted(() => ({
    websocketApi: vi.fn(),
    isConnected: undefined as unknown as { value: boolean },
}))
vi.mock('@/composables/useWebSocketConnection', () => ({
    useWebSocketConnection: () => ({
        websocketApi: connection.websocketApi,
        isConnected: connection.isConnected,
    }),
}))

const supportApi = vi.hoisted(() => ({ getChatHistory: vi.fn(), deleteChatHistory: vi.fn() }))
vi.mock('@/utils/api', () => ({ supportApi }))

const message = (id: string, role: 'user' | 'assistant', content: string) => ({
    id,
    role,
    content,
    screenshots: null,
    createdAt: '2026-11-10T10:00:00.000Z',
})

const GREETING = message('1', 'assistant', 'Hello, how can we help?')

const mountView = () =>
    mount(SupportView, {
        global: {
            plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
        },
    })

const textarea = (wrapper: ReturnType<typeof mountView>) => wrapper.get('textarea.support-input')

/** Types a message and sends it; the server accepts it (the answer comes as events). */
const send = async (wrapper: ReturnType<typeof mountView>, text: string): Promise<void> => {
    await textarea(wrapper).setValue(text)
    await wrapper.get('button.support-send-btn').trigger('click')
    await flushPromises()
}

beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    connection.isConnected = ref(true)
    connection.websocketApi.mockResolvedValue({ status: 'ok' })
    supportApi.getChatHistory.mockResolvedValue({ messages: [GREETING], hasMore: false })
})

describe('SupportView: the connection drops while an answer is awaited', () => {
    it('lets the user type again and drops the partial answer', async () => {
        const wrapper = mountView()
        await flushPromises()
        await send(wrapper, 'My invoice is wrong')
        useEventBus().emit('support_chat_token', { token: 'Let me ' })
        await flushPromises()
        expect(textarea(wrapper).attributes('disabled')).toBeDefined()
        expect(useSupportStore().isStreaming).toBe(true)

        connection.isConnected.value = false
        await flushPromises()

        expect(textarea(wrapper).attributes('disabled')).toBeUndefined()
        expect(useSupportStore().isStreaming).toBe(false)
        expect(useSupportStore().streamingContent).toBe('')
        expect(wrapper.text()).toContain('connection was lost')
    })

    it('reloads the conversation when the connection is back: the message is there once', async () => {
        const wrapper = mountView()
        await flushPromises()
        await send(wrapper, 'My invoice is wrong')
        connection.isConnected.value = false
        await flushPromises()
        supportApi.getChatHistory.mockResolvedValue({
            messages: [
                GREETING,
                message('2', 'user', 'My invoice is wrong'),
                message('3', 'assistant', 'Let me check that invoice.'),
            ],
            hasMore: false,
        })
        const loadsBefore = supportApi.getChatHistory.mock.calls.length

        connection.isConnected.value = true
        await flushPromises()

        expect(supportApi.getChatHistory.mock.calls.length).toBe(loadsBefore + 1)
        const shown = useSupportStore().messages
        expect(shown.filter((m) => m.content === 'My invoice is wrong')).toHaveLength(1)
        expect(shown.map((m) => m.content)).toContain('Let me check that invoice.')
        expect(wrapper.text()).not.toContain('connection was lost')
    })

    it('does nothing when the connection drops with no answer awaited', async () => {
        const wrapper = mountView()
        await flushPromises()
        const loadsBefore = supportApi.getChatHistory.mock.calls.length

        connection.isConnected.value = false
        await flushPromises()
        connection.isConnected.value = true
        await flushPromises()

        expect(supportApi.getChatHistory.mock.calls.length).toBe(loadsBefore)
        expect(wrapper.text()).not.toContain('connection was lost')
    })
})

describe('SupportView: the page is left while an answer is streamed', () => {
    it('leaves no partial answer behind, and the next visit reads the conversation again', async () => {
        const wrapper = mountView()
        await flushPromises()
        await send(wrapper, 'My invoice is wrong')
        useEventBus().emit('support_chat_token', { token: 'Let me ' })
        await flushPromises()

        wrapper.unmount()

        expect(useSupportStore().isStreaming).toBe(false)
        expect(useSupportStore().streamingContent).toBe('')

        // The answer went on without this page: what the server stored is the truth.
        const loadsBefore = supportApi.getChatHistory.mock.calls.length
        const again = mountView()
        await flushPromises()
        expect(supportApi.getChatHistory.mock.calls.length).toBe(loadsBefore + 1)

        useEventBus().emit('support_chat_token', { token: 'A new answer' })
        await flushPromises()
        expect(useSupportStore().streamingContent).toBe('A new answer')
        again.unmount()
    })

    it('keeps the cached conversation when the page is left with nothing in flight', async () => {
        const wrapper = mountView()
        await flushPromises()
        wrapper.unmount()
        const loadsBefore = supportApi.getChatHistory.mock.calls.length

        const again = mountView()
        await flushPromises()

        expect(supportApi.getChatHistory.mock.calls.length).toBe(loadsBefore)
        again.unmount()
    })
})

describe('SupportView: an answer that completes', () => {
    it('ends the wait and shows the answer, as before', async () => {
        const wrapper = mountView()
        await flushPromises()
        await send(wrapper, 'My invoice is wrong')
        useEventBus().emit('support_chat_token', { token: 'Let me check.' })
        useEventBus().emit('support_chat_complete', { content: 'Let me check.', screenshots: [] })
        await flushPromises()

        expect(textarea(wrapper).attributes('disabled')).toBeUndefined()
        expect(useSupportStore().messages.map((m) => m.content)).toEqual([
            'Hello, how can we help?',
            'My invoice is wrong',
            'Let me check.',
        ])
    })
})
