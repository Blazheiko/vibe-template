<script setup lang="ts">
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useNotificationsStore } from '@/stores/notifications'

// feat-236 (Р7): opens one notification, from the list or from a push in a new tab. Needs nothing
// loaded: the answer to "mark read" carries the link. Signed out, the router guard sends the user
// to sign in and back here.
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useNotificationsStore()

onMounted(async () => {
    const raw = route.params.id
    const id = Array.isArray(raw) ? (raw[0] ?? '') : raw
    const outcome = await store.markRead(id)
    if (outcome.kind === 'read') {
        await router.replace(outcome.link ?? '/notifications')
        return
    }
    await router.replace({
        path: '/notifications',
        query: { notice: outcome.kind === 'gone' ? 'gone' : 'error' },
    })
})
</script>

<template>
    <p class="opening" role="status" data-testid="notification-opening">
        {{ t('notifications.opening') }}
    </p>
</template>

<style scoped>
.opening {
    padding: 32px 16px;
    text-align: center;
    color: var(--text-secondary);
}
</style>
