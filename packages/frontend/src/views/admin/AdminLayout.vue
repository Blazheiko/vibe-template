<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useWebSocketConnection } from '@/composables/useWebSocketConnection'

const router = useRouter()
const route = useRoute()
const { websocketApi, statusWebSocket } = useWebSocketConnection()

const navItems = [
    { label: 'Knowledge Base', path: '/admin/knowledge-base', icon: 'kb' },
    { label: 'Users', path: '/admin/users', icon: 'users' },
    { label: 'User Online', path: '/admin/user-online', icon: 'online-users' },
    { label: 'History Online', path: '/admin/history-online', icon: 'history-online' },
]

function goBack() {
    void router.push('/account')
}

async function subscribeAdminChannel() {
    if (statusWebSocket.value !== 'OPEN') return
    try {
        await websocketApi('admin/subscribe_online_users')
    } catch (error) {
        console.error('Failed to subscribe admin channel:', error)
    }
}

async function unsubscribeAdminChannel() {
    if (statusWebSocket.value !== 'OPEN') return
    try {
        await websocketApi('admin/unsubscribe_online_users')
    } catch (error) {
        console.error('Failed to unsubscribe admin channel:', error)
    }
}

watch(statusWebSocket, (status) => {
    if (status === 'OPEN') {
        void subscribeAdminChannel()
    }
})

onMounted(() => {
    void subscribeAdminChannel()
})

onUnmounted(() => {
    void unsubscribeAdminChannel()
})
</script>

<template>
    <div class="admin-shell">
        <header class="admin-header">
            <span class="admin-header__title">Admin Panel</span>
            <button class="admin-header__back" @click="goBack">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                        d="M10 3L5 8l5 5"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    />
                </svg>
                Back to App
            </button>
        </header>

        <div class="admin-body">
            <nav class="admin-sidebar">
                <router-link
                    v-for="item in navItems"
                    :key="item.path"
                    :to="item.path"
                    class="admin-sidebar__item"
                    :class="{ 'admin-sidebar__item--active': route.path.startsWith(item.path) }"
                >
                    <svg
                        v-if="item.icon === 'kb'"
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="none"
                        aria-hidden="true"
                    >
                        <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.4" />
                        <path
                            d="M8 7v5M8 5v1"
                            stroke="currentColor"
                            stroke-width="1.4"
                            stroke-linecap="round"
                        />
                    </svg>
                    <svg
                        v-if="item.icon === 'users'"
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="none"
                        aria-hidden="true"
                    >
                        <circle cx="5.5" cy="5" r="2.2" stroke="currentColor" stroke-width="1.4" />
                        <circle cx="11.2" cy="6" r="1.8" stroke="currentColor" stroke-width="1.4" />
                        <path
                            d="M1.5 13c0-2.1 1.8-3.5 4-3.5s4 1.4 4 3.5"
                            stroke="currentColor"
                            stroke-width="1.4"
                            stroke-linecap="round"
                        />
                        <path
                            d="M9.2 12.8c.2-1.5 1.4-2.6 3.1-2.6 1 0 1.8.2 2.2.7"
                            stroke="currentColor"
                            stroke-width="1.4"
                            stroke-linecap="round"
                        />
                    </svg>
                    <svg
                        v-if="item.icon === 'online-users'"
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="none"
                        aria-hidden="true"
                    >
                        <circle cx="6" cy="5" r="2.4" stroke="currentColor" stroke-width="1.4" />
                        <path
                            d="M2 13c0-2.2 1.8-3.6 4-3.6s4 1.4 4 3.6"
                            stroke="currentColor"
                            stroke-width="1.4"
                            stroke-linecap="round"
                        />
                        <circle cx="12.5" cy="12.5" r="2.3" fill="currentColor" />
                    </svg>
                    <svg
                        v-if="item.icon === 'history-online'"
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="none"
                        aria-hidden="true"
                    >
                        <circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.4" />
                        <path
                            d="M8 4.5v3.8l2.5 1.5"
                            stroke="currentColor"
                            stroke-width="1.4"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        />
                    </svg>
                    {{ item.label }}
                </router-link>
            </nav>

            <main class="admin-content">
                <router-view />
            </main>
        </div>
    </div>
</template>

<style scoped>
.admin-shell {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    width: 100%;
    background-color: var(--bg-primary);
    color: var(--text-primary);
    overflow: hidden;
}

.admin-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 24px;
    height: 52px;
    min-height: 52px;
    background-color: var(--bg-secondary);
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
}

.admin-header__title {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text-primary);
}

.admin-header__back {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: none;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    color: var(--text-secondary);
    font-size: 0.8125rem;
    cursor: pointer;
    transition:
        color 0.15s,
        border-color 0.15s;
}

.admin-header__back:hover {
    color: var(--accent-color);
    border-color: var(--accent-color);
}

.admin-body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
}

.admin-sidebar {
    width: 220px;
    min-width: 220px;
    background-color: var(--bg-secondary);
    border-right: 1px solid var(--border-color);
    padding: 16px 12px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
}

.admin-sidebar__item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 0.875rem;
    text-decoration: none;
    transition:
        background-color 0.15s,
        color 0.15s;
}

.admin-sidebar__item:hover {
    background-color: var(--accent-hover);
    color: var(--accent-color);
}

.admin-sidebar__item--active {
    background-color: var(--accent-color);
    color: #fff;
    font-weight: 500;
}

.admin-content {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 24px;
}
</style>

<style src="../../assets/admin.css"></style>
