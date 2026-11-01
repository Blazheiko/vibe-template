<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import AdminUserDetailModal from '@/components/admin/AdminUserDetailModal.vue'
import { useAdminUserDetailModal } from '@/composables/useAdminUserDetailModal'
import { adminOnlineUsersApi } from '@/utils/api'
import { useEventBus } from '@/utils/event-bus'
import type { AdminOnlineUserListItem } from 'shared/responses'

const eventBus = useEventBus()

const users = ref<AdminOnlineUserListItem[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

const { isModalOpen, selectedUser, detailLoading, detailError, openUserModal, closeModal } =
    useAdminUserDetailModal()

function compareBigIntIdsDesc(a: { id: string }, b: { id: string }): number {
    const left = BigInt(a.id)
    const right = BigInt(b.id)
    if (right > left) return 1
    if (right < left) return -1
    return 0
}

async function loadUsers() {
    loading.value = true
    error.value = null

    const res = await adminOnlineUsersApi.list()
    loading.value = false

    if (res.data?.status === 'success') {
        users.value = [...res.data.items].sort(compareBigIntIdsDesc)
        return
    }

    users.value = []
    error.value = res.error?.message ?? 'Failed to load online users'
}

function upsertUser(user: AdminOnlineUserListItem) {
    const updated = [...users.value]
    const index = updated.findIndex((item) => item.id === user.id)
    if (index >= 0) {
        updated[index] = user
    } else {
        updated.unshift(user)
    }
    users.value = updated.sort(compareBigIntIdsDesc)
}

function removeUser(id: string) {
    users.value = users.value.filter((user) => user.id !== id)
    if (selectedUser.value?.id === id) {
        selectedUser.value = {
            ...selectedUser.value,
            appType: null,
            connections: [],
            isOnline: false,
            userAgent: null,
        }
    }
}

function formatAppType(appType: 'web' | 'pwa' | null): string {
    if (appType === null) return '—'
    return appType.toUpperCase()
}

const handleUpsert = (user: AdminOnlineUserListItem) => {
    upsertUser(user)
}

const handleRemove = ({ id }: { id: string }) => {
    removeUser(id)
}

onMounted(() => {
    eventBus.on('admin_user_online_upsert', handleUpsert)
    eventBus.on('admin_user_online_remove', handleRemove)
    void loadUsers()
})

onUnmounted(() => {
    eventBus.off('admin_user_online_upsert', handleUpsert)
    eventBus.off('admin_user_online_remove', handleRemove)
})
</script>

<template>
    <div class="admin-online">
        <div class="admin-online__header">
            <div>
                <h1 class="admin-online__title">User Online</h1>
                <p class="admin-online__subtitle">
                    Realtime list of users currently connected to the app
                </p>
            </div>
            <div class="admin-online__meta">Online now: {{ users.length }}</div>
        </div>

        <div v-if="loading" class="admin-online__loading">Loading online users...</div>
        <div v-else-if="error !== null" class="admin-online__error">{{ error }}</div>

        <div v-else class="table-wrap">
            <table class="online-table">
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Name</th>
                        <th>Email</th>
                        <th>App Type</th>
                    </tr>
                </thead>
                <tbody>
                    <tr
                        v-for="user in users"
                        :key="user.id"
                        class="online-table__row"
                        @click="openUserModal(user.id)"
                    >
                        <td class="cell-id">{{ user.id }}</td>
                        <td>{{ user.name }}</td>
                        <td class="cell-email">{{ user.email }}</td>
                        <td>{{ formatAppType(user.appType) }}</td>
                    </tr>
                    <tr v-if="users.length === 0">
                        <td colspan="4" class="empty-row">No users online</td>
                    </tr>
                </tbody>
            </table>
        </div>
        <AdminUserDetailModal
            :open="isModalOpen"
            :loading="detailLoading"
            :error="detailError"
            :user="selectedUser"
            @close="closeModal"
        />
    </div>
</template>

<style scoped>
.admin-online {
    padding: 24px;
    color: var(--text-primary);
}

.admin-online__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 20px;
}

.admin-online__title {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
}

.admin-online__subtitle {
    margin: 6px 0 0;
    color: var(--text-secondary);
    font-size: 0.875rem;
}

.admin-online__meta,
.admin-online__loading,
.admin-online__error {
    color: var(--text-secondary);
    font-size: 0.875rem;
}

.online-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
}

.online-table th,
.online-table td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-color);
    text-align: left;
}

.online-table th {
    font-weight: 600;
    color: var(--text-secondary);
    font-size: 0.8125rem;
}

.online-table__row {
    cursor: pointer;
    transition: background-color 0.15s ease;
}

.online-table__row:hover {
    background: color-mix(in srgb, var(--accent-color) 6%, transparent);
}

@media (max-width: 900px) {
    .admin-online {
        padding: 16px;
    }

    .admin-online__header {
        flex-direction: column;
    }
}
</style>
