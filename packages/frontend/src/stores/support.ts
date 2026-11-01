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
    // Older messages exist on the server than the ones shown ("show earlier").
    const hasMoreHistory = ref(false)
    const isLoadingEarlier = ref(false)
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
                    // A failed read is not an empty conversation: keep what is shown.
                    if (history === null) throw new Error('Failed to load history')
                    messages.value = history.messages
                    hasMoreHistory.value = history.hasMore
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
            hasMoreHistory.value = false
            streamingContent.value = ''
            isStreaming.value = false
            markHistoryLoaded()
        }
    }

    /** The id of the oldest message the server has sent (not one added here, not yet stored). */
    function oldestServerId(): string | undefined {
        return messages.value.find((m) => /^\d+$/.test(m.id))?.id
    }

    /**
     * Fetches the page before the oldest message shown and puts it in front. Returns how
     * many messages were added (0: nothing earlier, a page already loading, or a failure,
     * which is shown as the error and leaves the conversation as it was).
     */
    async function loadEarlier(): Promise<number> {
        const before = oldestServerId()
        if (!hasMoreHistory.value || isLoadingEarlier.value || before === undefined) return 0

        isLoadingEarlier.value = true
        try {
            const page = await supportApi.getChatHistory({ before })
            if (page === null) {
                error.value = 'Failed to load earlier messages'
                return 0
            }
            const known = new Set(messages.value.map((m) => m.id))
            const fresh = page.messages.filter((m) => !known.has(m.id))
            messages.value = [...fresh, ...messages.value]
            hasMoreHistory.value = page.hasMore
            return fresh.length
        } catch (caughtError) {
            error.value =
                caughtError instanceof Error
                    ? caughtError.message
                    : 'Failed to load earlier messages'
            return 0
        } finally {
            isLoadingEarlier.value = false
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

    function setLoading(val: boolean): void {
        isLoading.value = val
    }

    function setError(msg: string | null): void {
        error.value = msg
    }

    function reset(): void {
        messages.value = []
        hasMoreHistory.value = false
        isLoadingEarlier.value = false
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
        hasMoreHistory,
        isLoadingEarlier,
        streamingContent,
        isStreaming,
        error,
        historyResource: historyResource.state,
        loadHistory,
        ensureSupportHistoryLoaded,
        loadEarlier,
        clearHistory,
        appendToken,
        completeStreaming,
        addUserMessage,
        removeMessage,
        setLoading,
        setError,
        reset,
    }
})
