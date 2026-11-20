<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { NotificationPreference } from 'shared/notifications'
import { notificationsApi } from '@/utils/api'
import { useEventBus } from '@/utils/event-bus'

// feat-236 (Р4, Р11): the channels of each notification category. A locked channel is shown on
// and cannot be changed. Read again on every `ws_ready` and when another tab changes it.
const { t } = useI18n()
const eventBus = useEventBus()

const preferences = ref<NotificationPreference[]>([])
const loaded = ref(false)
const error = ref<'load' | 'save' | null>(null)
const saving = ref<string | null>(null)

const cellKey = (cell: Pick<NotificationPreference, 'category' | 'channel'>): string =>
    `${cell.category}.${cell.channel}`

let generation = 0
const load = async (): Promise<void> => {
    const mine = ++generation
    const { data, error: failure } = await notificationsApi.getPreferences()
    if (mine !== generation) return
    if (failure !== null || data?.status !== 'success') {
        if (!loaded.value) error.value = 'load'
        return
    }
    preferences.value = data.preferences
    loaded.value = true
    if (error.value === 'load') error.value = null
}

const toggle = async (cell: NotificationPreference): Promise<void> => {
    if (cell.locked || saving.value !== null) return
    const key = cellKey(cell)
    const enabled = !cell.enabled
    saving.value = key
    error.value = null
    // Shown at once; put back if the server refuses.
    preferences.value = preferences.value.map((item) =>
        cellKey(item) === key ? { ...item, enabled } : item,
    )
    const mine = ++generation
    try {
        const { data, error: failure } = await notificationsApi.updatePreference({
            category: cell.category,
            channel: cell.channel,
            enabled,
        })
        if (failure !== null || data?.status !== 'success') {
            if (mine === generation) {
                preferences.value = preferences.value.map((item) =>
                    cellKey(item) === key ? { ...item, enabled: !enabled } : item,
                )
            }
            error.value = 'save'
            return
        }
        if (mine === generation) preferences.value = data.preferences
    } finally {
        saving.value = null
    }
}

const reload = (): void => {
    void load()
}

onMounted(() => {
    void load()
    eventBus.on('ws_ready', reload)
    eventBus.on('notification_preferences_changed', reload)
})
onBeforeUnmount(() => {
    eventBus.off('ws_ready', reload)
    eventBus.off('notification_preferences_changed', reload)
})
</script>

<template>
    <section class="panel" data-testid="notification-preferences">
        <h2>{{ t('notifications.preferences.title') }}</h2>
        <p class="hint">{{ t('notifications.preferences.hint') }}</p>
        <p v-if="error === 'load'" class="form-message status-warning" role="alert">
            {{ t('notifications.preferences.errorLoad') }}
        </p>
        <p v-if="error === 'save'" class="form-message status-warning" role="alert">
            {{ t('notifications.preferences.errorSave') }}
        </p>
        <ul v-if="loaded" class="matrix">
            <li
                v-for="cell in preferences"
                :key="cellKey(cell)"
                class="cell"
                :data-testid="`preference-${cell.category}-${cell.channel}`"
            >
                <label :title="cell.locked ? t('notifications.preferences.locked') : undefined">
                    <input
                        type="checkbox"
                        :checked="cell.enabled"
                        :disabled="cell.locked || saving !== null"
                        @change="toggle(cell)"
                    />
                    <span>
                        {{ t(`notifications.preferences.categories.${cell.category}`) }} ·
                        {{ t(`notifications.preferences.channels.${cell.channel}`) }}
                    </span>
                    <small v-if="cell.locked" class="locked">
                        {{ t('notifications.preferences.locked') }}
                    </small>
                </label>
            </li>
        </ul>
    </section>
</template>

<style scoped>
.matrix {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.cell label {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}
.locked {
    color: var(--text-secondary);
}
</style>
