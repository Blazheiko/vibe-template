<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import NotificationItem from '@/components/notifications/NotificationItem.vue'
import { useNotificationsStore } from '@/stores/notifications'

// feat-236 (Р11): the bell of the header with the unread count, and a panel with the latest
// notifications. An open panel counts in `listOpen`; every way it closes calls closeList once.
const { t } = useI18n()
const route = useRoute()
const store = useNotificationsStore()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

const latest = computed(() => store.panelItems)

const onDocumentClick = (event: MouseEvent): void => {
    if (root.value !== null && !root.value.contains(event.target as Node)) close()
}
const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close()
}

function show(): void {
    if (open.value) return
    open.value = true
    // Its own list of the latest notifications: the history page keeps its filter and pages.
    store.openList('panel')
    document.addEventListener('click', onDocumentClick, true)
    document.addEventListener('keydown', onKeydown)
}

function close(): void {
    if (!open.value) return
    open.value = false
    store.closeList('panel')
    document.removeEventListener('click', onDocumentClick, true)
    document.removeEventListener('keydown', onKeydown)
}

const toggle = (): void => {
    if (open.value) close()
    else show()
}

watch(() => route.fullPath, close)
onBeforeUnmount(close)

defineExpose({ show, close })
</script>

<template>
    <div ref="root" class="notification-bell">
        <button
            type="button"
            class="bell-button"
            :aria-expanded="open ? 'true' : 'false'"
            aria-haspopup="true"
            :aria-label="t('notifications.bell')"
            :title="t('notifications.bell')"
            data-testid="notification-bell"
            @click="toggle"
        >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path
                    fill="currentColor"
                    d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm6-6V11a6 6 0 0 0-4.5-5.81V4.5a1.5 1.5 0 0 0-3 0v.69A6 6 0 0 0 6 11v5l-2 2v1h16v-1l-2-2z"
                />
            </svg>
            <span
                v-if="store.unreadCount > 0"
                class="badge"
                data-testid="notification-badge"
                aria-hidden="true"
                >{{ store.badge }}</span
            >
        </button>
        <span class="visually-hidden" aria-live="polite">
            {{ t('notifications.unreadLabel', { count: store.badge }) }}
        </span>

        <div v-if="open" class="panel-popover" role="dialog" data-testid="notification-panel">
            <div class="panel-head">
                <strong>{{ t('notifications.title') }}</strong>
                <button
                    type="button"
                    class="link-button"
                    :disabled="store.unreadCount === 0 || latest.length === 0"
                    data-testid="notifications-mark-all"
                    @click="store.markAllRead('panel')"
                >
                    {{ t('notifications.markAllRead') }}
                </button>
            </div>
            <p v-if="store.panelFailed && !store.panelLoaded" class="panel-state" role="alert">
                {{ t('notifications.errorLoad') }}
            </p>
            <p v-else-if="store.panelLoaded && latest.length === 0" class="panel-state">
                {{ t('notifications.empty') }}
            </p>
            <div v-else class="panel-list">
                <NotificationItem v-for="item in latest" :key="item.id" :item="item" compact />
            </div>
            <RouterLink to="/notifications" class="panel-footer" data-testid="notifications-all">
                {{ t('notifications.showAll') }}
            </RouterLink>
        </div>
    </div>
</template>

<style scoped>
.notification-bell {
    position: relative;
}
.bell-button {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: inherit;
    cursor: pointer;
}
.bell-button:hover,
.bell-button:focus-visible {
    background: rgba(255, 255, 255, 0.15);
}
.badge {
    position: absolute;
    top: 2px;
    right: 0;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 8px;
    background: var(--danger-color, #d93025);
    color: #fff;
    font-size: 10px;
    line-height: 16px;
    text-align: center;
}
.panel-popover {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    width: min(360px, calc(100vw - 32px));
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    background: var(--surface-color, #fff);
    color: var(--text-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md, 8px);
    box-shadow: var(--shadow-lg);
    z-index: 400;
    overflow: hidden;
}
.panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-color);
}
.link-button {
    border: none;
    background: none;
    color: var(--accent-color);
    cursor: pointer;
    font-size: 0.85em;
}
.link-button:disabled {
    color: var(--text-secondary);
    cursor: default;
}
.panel-list {
    overflow-y: auto;
}
.panel-state {
    padding: 16px 14px;
    color: var(--text-secondary);
    margin: 0;
}
.panel-footer {
    padding: 10px 14px;
    text-align: center;
    color: var(--accent-color);
    text-decoration: none;
    border-top: 1px solid var(--border-color);
}
.visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
}
</style>
