import { defineStore } from 'pinia'
import { ref } from 'vue'
import { supportApi } from '@/utils/api'
import type { SupportChatMessage } from '@/utils/api'
import { createResource, isAbortError } from '@/utils/resource-state'

export type { SupportChatMessage }

export const useSupportStore = defineStore('support', () => {
    const messages = ref<SupportChatMessage[]>([])
    const isLoading = ref(false)
    const isLoadingHistory = ref(false)
    const streamingContent = ref('')
    const isStreaming = ref(false)
    const historyResource = createResource(30_000)
    const error = ref<string | null>(null)

    function markHistoryLoaded(): void {
        historyResource.state.isLoaded = true
        historyResource.state.isStale = false
        historyResource.state.loadedAt = Date.now()
    }

    async function runHistoryLoad(force: boolean): Promise<void> {
        try {
            isLoadingHistory.value = true
            error.value = null
            await historyResource.ensureLoaded(
                async ({ signal, isAborted }) => {
                    const history = await supportApi.getChatHistory({ signal })
                    if (isAborted()) {
                        throw new DOMException('The operation was aborted.', 'AbortError')
                    }
                    messages.value = history
                },
                { force },
            )
        } catch (caughtError) {
            if (isAbortError(caughtError)) {
                return
            }
            const nextError =
                caughtError instanceof Error ? caughtError.message : 'Failed to load history'
            historyResource.state.error = nextError
            error.value = nextError
        } finally {
            isLoadingHistory.value = false
        }
    }

    async function loadHistory(): Promise<void> {
        await runHistoryLoad(true)
    }

    async function ensureSupportHistoryLoaded(force = false): Promise<void> {
        await runHistoryLoad(force)
    }

    async function clearHistory(): Promise<void> {
        const ok = await supportApi.deleteChatHistory()
        if (ok) {
            messages.value = []
            streamingContent.value = ''
            isStreaming.value = false
            markHistoryLoaded()
        }
    }

    function appendToken(token: string): void {
        streamingContent.value += token
        isStreaming.value = true
    }

    function completeStreaming(content: string, screenshots: string[] = []): void {
        isStreaming.value = false
        if (content) {
            messages.value.push({
                id: String(Date.now()),
                role: 'assistant',
                content,
                screenshots: screenshots.length > 0 ? screenshots : null,
                createdAt: new Date().toISOString(),
            })
        }
        streamingContent.value = ''
    }

    function addUserMessage(text: string): void {
        messages.value.push({
            id: String(Date.now()),
            role: 'user',
            content: text,
            screenshots: null,
            createdAt: new Date().toISOString(),
        })
    }

    /**
     * Takes back the message added optimistically when the server refused it, so the
     * conversation does not show a message that was never accepted.
     */
    function removeLastUserMessage(): void {
        const last = messages.value.at(-1)
        if (last?.role === 'user') messages.value.pop()
    }

    function setLoading(val: boolean): void {
        isLoading.value = val
    }

    function setError(msg: string | null): void {
        error.value = msg
    }

    function reset(): void {
        messages.value = []
        isLoading.value = false
        isLoadingHistory.value = false
        streamingContent.value = ''
        isStreaming.value = false
        error.value = null
        historyResource.reset()
    }

    return {
        messages,
        isLoading,
        isLoadingHistory,
        streamingContent,
        isStreaming,
        error,
        historyResource: historyResource.state,
        loadHistory,
        ensureSupportHistoryLoaded,
        clearHistory,
        appendToken,
        completeStreaming,
        addUserMessage,
        removeLastUserMessage,
        setLoading,
        setError,
        reset,
    }
})
