<script setup lang="ts">
import { ref, useId } from 'vue'
import type { AdminOnlineUserDetail } from 'shared/responses'
import { useModalDialog } from '@/composables/useModalDialog'

const props = defineProps<{
    open: boolean
    loading: boolean
    error: string | null
    user: AdminOnlineUserDetail | null
}>()

const emit = defineEmits<(e: 'close') => void>()

function closeModal() {
    emit('close')
}

const panel = ref<HTMLElement | null>(null)
const titleId = useId()
useModalDialog({ panel, isOpen: () => props.open, close: closeModal })

function formatDate(value: string | null): string {
    if (value === null) return '—'
    return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(new Date(value))
}

function formatAppType(appType: 'web' | 'pwa' | null): string {
    if (appType === null) return '—'
    return appType.toUpperCase()
}
</script>

<template>
    <div v-if="open" class="online-modal-overlay" @click.self="closeModal">
        <div
            ref="panel"
            class="online-modal"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="titleId"
            tabindex="-1"
        >
            <div class="online-modal__header">
                <div>
                    <h2 :id="titleId" class="online-modal__title">User Details</h2>
                    <div v-if="user !== null" class="online-modal__status">
                        <span
                            :class="[
                                'status-badge',
                                user.isOnline ? 'status-badge--online' : 'status-badge--offline',
                            ]"
                        >
                            {{ user.isOnline ? 'Online' : 'Offline' }}
                        </span>
                    </div>
                </div>
                <button
                    class="online-modal__close"
                    type="button"
                    aria-label="Close"
                    data-modal-close
                    @click="closeModal"
                >
                    ✕
                </button>
            </div>

            <div class="online-modal__body">
                <div v-if="loading" class="online-modal__loading">Loading details...</div>
                <div v-else-if="error !== null" class="online-modal__error">{{ error }}</div>
                <div v-else-if="user !== null" class="detail-grid">
                    <div class="detail-row">
                        <span>ID</span><strong>{{ user.id }}</strong>
                    </div>
                    <div class="detail-row">
                        <span>Name</span><strong>{{ user.name }}</strong>
                    </div>
                    <div class="detail-row">
                        <span>Email</span><strong>{{ user.email }}</strong>
                    </div>
                    <div class="detail-row">
                        <span>Phone</span><strong>{{ user.phone ?? '—' }}</strong>
                    </div>
                    <div class="detail-row">
                        <span>Role</span><strong>{{ user.role }}</strong>
                    </div>
                    <div class="detail-row">
                        <span>Registered At</span><strong>{{ formatDate(user.createdAt) }}</strong>
                    </div>
                    <div class="detail-row">
                        <span>App Type</span><strong>{{ formatAppType(user.appType) }}</strong>
                    </div>
                    <div class="detail-row detail-row--wide">
                        <span>User Agent</span><strong>{{ user.userAgent ?? '—' }}</strong>
                    </div>
                    <div class="detail-row detail-row--wide">
                        <span>Active Connections</span>
                        <div v-if="user.connections.length > 0" class="connections-list">
                            <div
                                v-for="connection in user.connections"
                                :key="connection.uuid"
                                class="connection-card"
                            >
                                <div class="connection-card__row">
                                    <span>IP</span>
                                    <strong>{{ connection.ip }}</strong>
                                </div>
                                <div class="connection-card__row">
                                    <span>User Agent</span>
                                    <strong>{{ connection.userAgent }}</strong>
                                </div>
                                <div class="connection-card__row">
                                    <span>App Type</span>
                                    <strong>{{ formatAppType(connection.appType) }}</strong>
                                </div>
                            </div>
                        </div>
                        <strong v-else>—</strong>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.online-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    z-index: 50;
}

.online-modal {
    width: min(760px, 100%);
    max-height: calc(100dvh - 32px);
    overflow: auto;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 14px;
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.2);
}

.online-modal:focus {
    outline: none;
}

.online-modal__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 18px 20px;
    border-bottom: 1px solid var(--border-color);
}

.online-modal__title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
}

.online-modal__status {
    margin-top: 8px;
}

.online-modal__close {
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
    color: var(--text-primary);
    border-radius: 8px;
    padding: 6px 10px;
    cursor: pointer;
}

.online-modal__body {
    padding: 20px;
}

.online-modal__loading,
.online-modal__error {
    color: var(--text-secondary);
    font-size: 0.875rem;
}

.detail-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px 18px;
}

.detail-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 14px;
    border: 1px solid var(--border-color);
    border-radius: 10px;
    background: var(--bg-secondary);
}

.detail-row span {
    color: var(--text-secondary);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
}

.detail-row strong {
    font-size: 0.875rem;
    line-height: 1.4;
    word-break: break-word;
}

.detail-row--wide {
    grid-column: 1 / -1;
}

.connections-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.connection-card {
    border: 1px solid var(--border-color);
    border-radius: 10px;
    background: var(--bg-primary);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.connection-card__row {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.connection-card__row span {
    color: var(--text-secondary);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
}

.connection-card__row strong {
    font-size: 0.8125rem;
    line-height: 1.4;
    word-break: break-word;
}

.status-badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
}

.status-badge--online {
    background: color-mix(in srgb, var(--success, #2e7d52) 12%, transparent);
    color: var(--success, #2e7d52);
}

.status-badge--offline {
    background: color-mix(in srgb, var(--text-secondary) 15%, transparent);
    color: var(--text-secondary);
}

@media (max-width: 900px) {
    .detail-grid {
        grid-template-columns: 1fr;
    }
}
</style>
