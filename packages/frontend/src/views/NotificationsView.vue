<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import NotificationItem from '@/components/notifications/NotificationItem.vue'
import { useNotificationsStore } from '@/stores/notifications'

// feat-236 (Р11): the history of the user's notifications, all or the unread ones, with "show
// more". While it is mounted the list counts as open, so every recovery point reads it again.
const { t } = useI18n()
const route = useRoute()
const store = useNotificationsStore()

const notice = computed(() => {
    const value = route.query.notice
    return value === 'gone' || value === 'error' ? value : null
})

onMounted(() => {
    store.openList()
})
onBeforeUnmount(() => {
    store.closeList()
})
</script>

<template>
    <div class="notifications-page">
        <header class="page-head">
            <h1>{{ t('notifications.title') }}</h1>
            <button
                type="button"
                class="secondary-button"
                :disabled="store.unreadCount === 0 || store.items.length === 0"
                data-testid="notifications-page-mark-all"
                @click="store.markAllRead()"
            >
                {{ t('notifications.markAllRead') }}
            </button>
        </header>

        <p
            v-if="notice !== null"
            class="form-message status-warning"
            role="status"
            data-testid="notifications-notice"
        >
            {{ t(`notifications.notice.${notice}`) }}
        </p>

        <div class="tabs" role="tablist">
            <button
                type="button"
                role="tab"
                :aria-selected="!store.unreadOnly"
                :class="{ active: !store.unreadOnly }"
                data-testid="notifications-tab-all"
                @click="store.setUnreadOnly(false)"
            >
                {{ t('notifications.all') }}
            </button>
            <button
                type="button"
                role="tab"
                :aria-selected="store.unreadOnly"
                :class="{ active: store.unreadOnly }"
                data-testid="notifications-tab-unread"
                @click="store.setUnreadOnly(true)"
            >
                {{ t('notifications.unread') }}
                <span v-if="store.unreadCount > 0" class="count">{{ store.badge }}</span>
            </button>
        </div>

        <div
            v-if="store.loadFailed && !store.loaded"
            class="form-message status-warning"
            role="alert"
            data-testid="notifications-error"
        >
            {{ t('notifications.errorLoad') }}
            <button type="button" class="secondary-button" @click="store.readNow()">
                {{ t('notifications.retry') }}
            </button>
        </div>
        <p
            v-else-if="store.loaded && store.items.length === 0"
            class="empty"
            data-testid="notifications-empty"
        >
            {{ store.unreadOnly ? t('notifications.emptyUnread') : t('notifications.empty') }}
        </p>
        <div v-else class="list" data-testid="notifications-list">
            <NotificationItem v-for="item in store.items" :key="item.id" :item="item" />
        </div>

        <button
            v-if="store.next !== null"
            type="button"
            class="secondary-button more"
            :disabled="store.loadingMore"
            data-testid="notifications-more"
            @click="store.loadMore()"
        >
            {{ t('notifications.showMore') }}
        </button>
    </div>
</template>

<style scoped>
.notifications-page {
    max-width: 720px;
    margin: 0 auto;
    padding: 24px 16px;
}
.page-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
}
.page-head h1 {
    margin: 0;
    font-size: 1.5rem;
}
.tabs {
    display: flex;
    gap: 4px;
    margin: 16px 0 8px;
    border-bottom: 1px solid var(--border-color);
}
.tabs button {
    border: none;
    background: none;
    padding: 8px 12px;
    color: var(--text-secondary);
    cursor: pointer;
    border-bottom: 2px solid transparent;
}
.tabs button.active {
    color: var(--accent-color);
    border-bottom-color: var(--accent-color);
}
.count {
    margin-left: 4px;
    font-size: 0.8em;
}
.list {
    background: var(--surface-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md, 8px);
    overflow: hidden;
}
.empty {
    color: var(--text-secondary);
    padding: 24px 0;
}
.more {
    display: block;
    margin: 16px auto 0;
}
</style>
