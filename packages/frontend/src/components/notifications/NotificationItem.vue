<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { NotificationItem } from 'shared'
import { useDateFormat } from '@/composables/useDateFormat'
import { oauthProviderLabel } from '@/utils/oauth-provider-label'

// feat-236 (Р3): one notification. The text comes from the kind and its params in the language
// of the interface; a click opens it through /notifications/:id/open (Р7).
const props = defineProps<{ item: NotificationItem; compact?: boolean }>()
const emit = defineEmits<{ open: [] }>()

const { t } = useI18n()
const { formatRelative, formatDateTime } = useDateFormat()

const key = computed(() => `notifications.kinds.${props.item.kind.replace(/\./g, '_')}`)
const values = computed(() => {
    const params = props.item.params as { device?: string; provider?: string }
    return {
        device: params.device ?? '',
        provider: params.provider === undefined ? '' : oauthProviderLabel(params.provider),
    }
})
const unread = computed(() => props.item.readAt === null)
</script>

<template>
    <RouterLink
        :to="`/notifications/${item.id}/open`"
        class="notification-item"
        :class="{ unread, compact }"
        :data-testid="`notification-${item.id}`"
        :data-unread="unread ? 'true' : 'false'"
        @click="emit('open')"
    >
        <span v-if="unread" class="dot" aria-hidden="true"></span>
        <span class="content">
            <span class="title">{{ t(`${key}.title`, values) }}</span>
            <span class="body">{{ t(`${key}.body`, values) }}</span>
            <time class="time" :datetime="item.createdAt" :title="formatDateTime(item.createdAt)">
                {{ formatRelative(item.createdAt) }}
            </time>
        </span>
    </RouterLink>
</template>

<style scoped>
.notification-item {
    display: flex;
    gap: 10px;
    padding: 12px 14px;
    color: var(--text-color);
    text-decoration: none;
    border-bottom: 1px solid var(--border-color);
    position: relative;
}
.notification-item:hover,
.notification-item:focus-visible {
    background: var(--accent-light);
}
.notification-item.unread .title {
    font-weight: 600;
}
.dot {
    flex: none;
    width: 8px;
    height: 8px;
    margin-top: 6px;
    border-radius: 50%;
    background: var(--accent-color);
}
.content {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}
.body {
    color: var(--text-secondary);
    font-size: 0.9em;
    overflow-wrap: anywhere;
}
.compact .body {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
.time {
    color: var(--text-secondary);
    font-size: 0.8em;
}
</style>
