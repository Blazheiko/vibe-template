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
    // Messages added here before the server has seen them get their own id: a timestamp
    // is not one (two messages within a millisecond), and the id is what takes one back.
    let localMessageCounter = 0
    const nextLocalId = (): string => `local-${String(++localMessageCounter)}`

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
                id: nextLocalId(),
                role: 'assistant',
                content,
                screenshots: screenshots.length > 0 ? screenshots : null,
                createdAt: new Date().toISOString(),
            })
        }
        streamingContent.value = ''
    }

    /** Adds the message optimistically; the returned id takes it back (`removeMessage`). */
    function addUserMessage(text: string): string {
        const id = nextLocalId()
        messages.value.push({
            id,
            role: 'user',
            content: text,
            screenshots: null,
            createdAt: new Date().toISOString(),
        })
        return id
    }

    /**
     * Takes back the message added optimistically when the server refused it, so the
     * conversation does not show a message that was never accepted. By id, not by position:
     * the greeting may have completed after it and before the refusal arrived.
     */
    function removeMessage(id: string): void {
        const index = messages.value.findIndex((m) => m.id === id)
        if (index !== -1) messages.value.splice(index, 1)
    }

    function countUserMessages(text: string): number {
        return messages.value.filter((m) => m.role === 'user' && m.content === text).length
    }

    /**
     * After a send whose outcome is unknown (timeout, dropped connection): did the server
     * keep the message? Compares the stored history with `countBefore`, the number of such
     * messages there were before the send. The history replaces the local list, so a
     * message that never arrived disappears from it. `null` when it cannot be told.
     */
    async function confirmDelivery(text: string, countBefore: number): Promise<boolean | null> {
        let history: SupportChatMessage[]
        try {
            history = await supportApi.getChatHistory()
        } catch {
            return null
        }
        // getChatHistory answers [] for a failed request as well as for a real empty history.
        if (history.length === 0 && messages.value.length > 0) return null

        messages.value = history
        markHistoryLoaded()
        return countUserMessages(text) > countBefore
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
        removeMessage,
        countUserMessages,
        confirmDelivery,
        setLoading,
        setError,
        reset,
    }
})
