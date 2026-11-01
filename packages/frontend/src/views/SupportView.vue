<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSupportStore } from '@/stores/support'
import { useEventBus } from '@/utils/event-bus'
import { apiPath } from '@/utils/api-path'
import { useWebSocketConnection } from '@/composables/useWebSocketConnection'
import { getResponseMessage } from '@/utils/response-normalizer'
import { SUPPORT_MESSAGE_MAX_LENGTH } from 'shared/limits'

const props = defineProps<{
    embedded?: boolean
}>()

const { t, locale } = useI18n()
const store = useSupportStore()
const eventBus = useEventBus()
const { websocketApi } = useWebSocketConnection()

const chatContainer = ref<HTMLElement | null>(null)
const textInput = ref('')
const isSending = ref(false)
const isOpeningChat = ref(false)
const sessionReady = ref(false)

const displayMessages = computed(() => store.messages)

function messageText(content: string): string {
    return content.replace(/\[screenshot:\d+\]/g, '').trim()
}

function hideOnError(e: Event): void {
    ;(e.target as HTMLImageElement).style.display = 'none'
}
const streamingText = computed(() => store.streamingContent)
const isStreaming = computed(() => store.isStreaming)
const isEmptyState = computed(
    () => displayMessages.value.length === 0 && !isStreaming.value && !store.isLoadingHistory,
)

function scrollToBottom(): void {
    void nextTick(() => {
        if (chatContainer.value) {
            chatContainer.value.scrollTop = chatContainer.value.scrollHeight
        }
    })
}

function onSupportChatToken(data: { token: string }): void {
    store.appendToken(data.token)
    scrollToBottom()
}

function onSupportChatComplete(data: { content: string; screenshots: string[] }): void {
    store.completeStreaming(data.content, data.screenshots)
    sessionReady.value = true
    isSending.value = false
    scrollToBottom()
}

function onSupportChatError(data: { message: string }): void {
    store.setError(data.message)
    store.completeStreaming('')
    isSending.value = false
}

async function openChat(): Promise<boolean> {
    if (isOpeningChat.value) return false

    isOpeningChat.value = true
    store.setError(null)

    try {
        await websocketApi('support/support_open_chat', { language: locale.value })
        sessionReady.value = true
        return true
    } catch (error) {
        sessionReady.value = false
        store.setError(getResponseMessage(error, 'Failed to open support chat'))
        return false
    } finally {
        isOpeningChat.value = false
    }
}

async function ensureSessionReady(): Promise<boolean> {
    if (sessionReady.value || displayMessages.value.length > 0) {
        sessionReady.value = true
        return true
    }

    return await openChat()
}

async function sendMessage(textOverride?: string): Promise<void> {
    const text = (textOverride ?? textInput.value).trim()
    if (!text || isSending.value) return

    const ready = await ensureSessionReady()
    if (!ready) return

    store.addUserMessage(text)
    textInput.value = ''
    isSending.value = true
    store.setError(null)
    scrollToBottom()

    try {
        await websocketApi('support/support_chat', {
            message: text,
            language: locale.value,
        })
    } catch (error) {
        // The server refused the message before accepting it (too frequent, the previous
        // answer is still being written, too long): nothing was sent, so the text goes
        // back into the input for another try.
        isSending.value = false
        store.removeLastUserMessage()
        textInput.value = text
        store.setError(getResponseMessage(error, 'Failed to send message'))
    }
}

function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void sendMessage()
    }
}

async function clearHistory(): Promise<void> {
    await store.clearHistory()
    sessionReady.value = false
}

onMounted(async () => {
    eventBus.on('support_chat_token', onSupportChatToken)
    eventBus.on('support_chat_complete', onSupportChatComplete)
    eventBus.on('support_chat_error', onSupportChatError)

    await store.ensureSupportHistoryLoaded()
    sessionReady.value = store.messages.length > 0
    scrollToBottom()
})

onUnmounted(() => {
    eventBus.off('support_chat_token', onSupportChatToken)
    eventBus.off('support_chat_complete', onSupportChatComplete)
    eventBus.off('support_chat_error', onSupportChatError)
})
</script>

<template>
    <div class="support-view" :class="{ 'is-embedded': props.embedded }">
        <div class="tool-header">
            <div class="tool-header-copy">
                <span class="tool-header-title">{{ t('support.title') }}</span>
                <span class="tool-header-subtitle">{{ t('support.subtitle') }}</span>
            </div>
            <div class="tool-header-actions">
                <button
                    class="toolbar-btn toolbar-btn--danger"
                    :title="t('support.clearHistory')"
                    @click="clearHistory"
                >
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                        <path
                            d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
                        />
                    </svg>
                </button>
            </div>
        </div>

        <div class="support-body">
            <section class="support-panel">
                <div ref="chatContainer" class="support-messages">
                    <div v-if="store.isLoadingHistory" class="support-state">
                        <p>{{ t('support.loadingHistory') }}</p>
                    </div>

                    <div v-else-if="isEmptyState" class="support-state support-state--empty">
                        <div class="support-empty-card">
                            <div class="support-empty-icon">
                                <svg
                                    viewBox="0 0 24 24"
                                    width="28"
                                    height="28"
                                    fill="currentColor"
                                    aria-hidden="true"
                                >
                                    <path
                                        d="M12 2C6.48 2 2 5.58 2 10c0 2.38 1.27 4.54 3.3 6.02L4 21l4.45-2.09c1.12.35 2.31.54 3.55.54 5.52 0 10-3.58 10-8S17.52 2 12 2zm1 12h-2v-2h2v2zm0-4h-2V6h2v4z"
                                    />
                                </svg>
                            </div>
                            <h3>{{ t('support.emptyTitle') }}</h3>
                            <p>{{ t('support.emptyDescription') }}</p>
                            <button
                                class="support-start-btn support-start-btn--large"
                                :disabled="isOpeningChat"
                                @click="openChat"
                            >
                                <svg
                                    viewBox="0 0 24 24"
                                    width="18"
                                    height="18"
                                    fill="currentColor"
                                    aria-hidden="true"
                                >
                                    <path
                                        d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3z"
                                    />
                                    <path
                                        d="M19 11h-2a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z"
                                    />
                                </svg>
                                <span>{{
                                    isOpeningChat ? t('support.opening') : t('support.start')
                                }}</span>
                            </button>
                        </div>
                    </div>

                    <template v-else>
                        <div
                            v-for="msg in displayMessages"
                            :key="msg.id"
                            class="support-message"
                            :class="msg.role"
                        >
                            <div class="message-bubble">
                                <p class="message-text">{{ messageText(msg.content) }}</p>
                                <div
                                    v-if="msg.screenshots && msg.screenshots.length > 0"
                                    class="message-screenshots"
                                >
                                    <img
                                        v-for="articleId in msg.screenshots"
                                        :key="articleId"
                                        :src="
                                            apiPath(
                                                `support/screenshot/${encodeURIComponent(articleId)}`,
                                            )
                                        "
                                        class="message-screenshot"
                                        alt="Screenshot"
                                        @error="hideOnError"
                                    />
                                </div>
                            </div>
                        </div>

                        <div v-if="isStreaming" class="support-message assistant">
                            <div class="message-bubble">
                                <p class="message-text">
                                    {{ streamingText }}<span class="cursor">|</span>
                                </p>
                            </div>
                        </div>

                        <div v-if="isSending && !isStreaming" class="support-message assistant">
                            <div class="message-bubble typing-indicator">
                                <span /><span /><span />
                            </div>
                        </div>
                    </template>
                </div>

                <div v-if="store.error" class="support-error">{{ store.error }}</div>

                <div v-if="!isEmptyState" class="support-input-shell">
                    <div class="support-input-area">
                        <textarea
                            v-model="textInput"
                            class="support-input"
                            :placeholder="t('support.inputPlaceholder')"
                            rows="1"
                            :maxlength="SUPPORT_MESSAGE_MAX_LENGTH"
                            :disabled="isSending"
                            @keydown="handleKeydown"
                        />
                        <button
                            class="support-send-btn"
                            :disabled="isSending || !textInput.trim()"
                            @click="sendMessage()"
                        >
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                            </svg>
                        </button>
                    </div>
                    <div
                        v-if="textInput.length >= SUPPORT_MESSAGE_MAX_LENGTH * 0.8"
                        class="support-counter"
                        :class="{ full: textInput.length >= SUPPORT_MESSAGE_MAX_LENGTH }"
                    >
                        {{ textInput.length }} / {{ SUPPORT_MESSAGE_MAX_LENGTH }}
                    </div>
                </div>
            </section>
        </div>
    </div>
</template>

<style scoped>
.support-view {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    background: var(--bg-primary);
    color: var(--text-primary);
    min-height: 0;
}

.support-view.is-embedded {
    height: 100%;
}

.tool-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 20px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
}

.tool-header-copy {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
}

.tool-header-title {
    font-size: 18px;
    font-weight: 600;
}

.tool-header-subtitle {
    color: var(--text-secondary);
    font-size: 13px;
}

.tool-header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
}

.toolbar-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: 1px solid var(--border-color);
    border-radius: 10px;
    background: var(--bg-primary);
    color: var(--text-secondary);
    cursor: pointer;
    transition:
        background-color 0.15s ease,
        color 0.15s ease,
        border-color 0.15s ease;
}

.toolbar-btn:hover {
    color: var(--text-primary);
    border-color: var(--accent-color);
}

.toolbar-btn.active {
    color: var(--accent-color);
    border-color: color-mix(in srgb, var(--accent-color) 45%, var(--border-color));
}

.toolbar-btn--danger {
    color: var(--danger-color);
    border-color: color-mix(in srgb, var(--danger-color) 30%, var(--border-color));
}

.toolbar-btn--danger:hover {
    color: var(--danger-color);
    background: color-mix(in srgb, var(--danger-color) 8%, var(--bg-primary));
    border-color: var(--danger-color);
}

.support-body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}

.support-panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--bg-primary) 92%, white) 0%,
        var(--bg-primary) 100%
    );
}

.support-messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
}

.support-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    color: var(--text-secondary);
}

.support-state--empty {
    padding: 24px 0;
}

.support-empty-card {
    max-width: 420px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    text-align: center;
    padding: 28px;
    border-radius: 24px;
    border: 1px solid var(--border-color);
    background: color-mix(in srgb, var(--bg-secondary) 85%, white);
    box-shadow: 0 22px 50px rgba(69, 33, 51, 0.08);
}

.support-empty-icon {
    width: 64px;
    height: 64px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent-color) 16%, white);
    color: var(--accent-color);
}

.support-empty-card h3,
.support-empty-card p {
    margin: 0;
}

.support-empty-card p {
    color: var(--text-secondary);
    line-height: 1.5;
}

.support-message {
    display: flex;
}

.support-message.user {
    justify-content: flex-end;
}

.support-message.assistant {
    justify-content: flex-start;
}

.message-bubble {
    max-width: min(760px, 82%);
    padding: 14px 16px;
    border-radius: 18px;
    box-shadow: 0 10px 26px rgba(69, 33, 51, 0.06);
}

.support-message.user .message-bubble {
    background: color-mix(in srgb, var(--accent-color) 82%, white);
    color: #fff;
    border-bottom-right-radius: 6px;
}

.support-message.assistant .message-bubble {
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-bottom-left-radius: 6px;
}

.message-text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.55;
}

.message-screenshots {
    margin-top: 12px;
    display: grid;
    gap: 10px;
}

.message-screenshot {
    width: 100%;
    max-width: 420px;
    border-radius: 14px;
    border: 1px solid var(--border-color);
    display: block;
}

.typing-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}

.typing-indicator span {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-secondary);
    animation: supportTyping 1s infinite ease-in-out;
}

.typing-indicator span:nth-child(2) {
    animation-delay: 0.15s;
}

.typing-indicator span:nth-child(3) {
    animation-delay: 0.3s;
}

.cursor {
    animation: supportBlink 1s steps(1) infinite;
}

.support-error {
    margin: 0 24px 16px;
    padding: 12px 14px;
    border-radius: 14px;
    border: 1px solid rgba(214, 70, 90, 0.25);
    background: rgba(214, 70, 90, 0.08);
    color: #a53245;
    font-size: 14px;
}

.support-input-shell {
    border-top: 1px solid var(--border-color);
    background: color-mix(in srgb, var(--bg-secondary) 86%, white);
    flex-shrink: 0;
}

.support-input-area {
    display: flex;
    gap: 12px;
    padding: 16px 24px 12px;
    background: transparent;
    flex-shrink: 0;
}

.support-input {
    flex: 1;
    min-height: 52px;
    max-height: 160px;
    resize: none;
    padding: 14px 16px;
    border: 1px solid var(--border-color);
    border-radius: 18px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font: inherit;
    line-height: 1.4;
    outline: none;
}

.support-input:focus {
    border-color: var(--accent-color);
}

.support-counter {
    padding: 0 24px 10px;
    text-align: right;
    font-size: 12px;
    color: var(--text-secondary);
}

.support-counter.full {
    color: var(--accent-color);
}

.support-input:disabled {
    opacity: 0.7;
}

.support-send-btn,
.support-start-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: none;
    cursor: pointer;
    color: #fff;
    background: linear-gradient(
        135deg,
        color-mix(in srgb, var(--accent-color) 88%, white),
        var(--accent-color)
    );
}

.support-send-btn {
    width: 52px;
    height: 52px;
    border-radius: 16px;
    flex-shrink: 0;
}

.support-start-btn {
    min-height: 48px;
    padding: 0 18px;
    border-radius: 16px;
    font-weight: 600;
    align-self: flex-start;
}

.support-start-btn--large {
    min-height: 54px;
    padding: 0 22px;
}

.support-send-btn:disabled,
.support-start-btn:disabled {
    cursor: default;
    opacity: 0.6;
}

@keyframes supportTyping {
    0%,
    80%,
    100% {
        transform: scale(0.8);
        opacity: 0.4;
    }

    40% {
        transform: scale(1);
        opacity: 1;
    }
}

@keyframes supportBlink {
    50% {
        opacity: 0;
    }
}

@media (max-width: 1024px) {
    .support-messages {
        padding: 20px;
    }

    .support-input-area {
        padding: 16px 20px 12px;
    }
}

@media (max-width: 768px) {
    .tool-header {
        padding: 12px 16px;
    }

    .tool-header-subtitle {
        display: none;
    }

    .support-messages {
        padding: 16px;
    }

    .message-bubble {
        max-width: 92%;
    }

    .support-input-area {
        gap: 10px;
        padding: 14px 16px 10px;
    }

    .support-input {
        min-height: 48px;
    }

    .support-send-btn {
        width: 48px;
        height: 48px;
        border-radius: 14px;
    }
}
</style>
