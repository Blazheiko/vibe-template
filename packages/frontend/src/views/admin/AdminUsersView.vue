<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AdminFilterBar from '@/components/admin/AdminFilterBar.vue'
import AdminUserDetailModal from '@/components/admin/AdminUserDetailModal.vue'
import { useAdminUserDetailModal } from '@/composables/useAdminUserDetailModal'
import { adminUsersApi } from '@/utils/api'
import type { AdminUserListItem } from 'shared/responses'
import { getResponseMessage } from '@/utils/response-normalizer'

interface UserFilters {
    userId: string
    dateFrom: string
    dateTo: string
}

const users = ref<AdminUserListItem[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref<string | null>(null)
const { isModalOpen, selectedUser, detailLoading, detailError, openUserModal, closeModal } =
    useAdminUserDetailModal()

const filters = ref<UserFilters>({
    userId: '',
    dateFrom: '',
    dateTo: '',
})

async function loadUsers() {
    loading.value = true
    error.value = null

    const res = await adminUsersApi.list({
        limit: 100,
        userId: filters.value.userId,
        dateFrom: filters.value.dateFrom,
        dateTo: filters.value.dateTo,
    })

    loading.value = false

    if (res.data?.status === 'success') {
        users.value = res.data.items
        total.value = res.data.total
        return
    }

    users.value = []
    total.value = 0
    error.value = getResponseMessage(res.data, res.error?.message ?? 'Failed to load users')
}

function resetFilters() {
    filters.value = {
        userId: '',
        dateFrom: '',
        dateTo: '',
    }
    void loadUsers()
}

function formatDate(value: string): string {
    return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(new Date(value))
}

onMounted(() => {
    void loadUsers()
})
</script>

<template>
    <div class="admin-users">
        <div class="admin-users__header">
            <div>
                <h1 class="admin-users__title">Users</h1>
                <p class="admin-users__subtitle">Latest registrations</p>
            </div>
            <div class="admin-users__meta">Loaded: {{ users.length }} / {{ total }}</div>
        </div>

        <AdminFilterBar
            v-model="filters"
            from-label="Registered from"
            to-label="Registered to"
            :loading="loading"
            @submit="loadUsers"
            @reset="resetFilters"
        />

        <div v-if="loading" class="admin-users__loading">Loading users...</div>
        <div v-else-if="error !== null" class="admin-users__error">{{ error }}</div>

        <div v-else class="table-wrap">
            <table class="users-table">
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Name</th>
                        <th>Email</th>
                        <th>Registered At</th>
                    </tr>
                </thead>
                <tbody>
                    <tr
                        v-for="user in users"
                        :key="user.id"
                        class="users-table__row"
                        @click="openUserModal(user.id)"
                    >
                        <td class="cell-id">{{ user.id }}</td>
                        <td>{{ user.name }}</td>
                        <td class="cell-email">{{ user.email }}</td>
                        <td>{{ formatDate(user.registeredAt) }}</td>
                    </tr>
                    <tr v-if="users.length === 0">
                        <td colspan="4" class="empty-row">No users found</td>
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
.admin-users {
    padding: 24px;
    color: var(--text-primary);
}

.admin-users__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 20px;
}

.admin-users__title {
    font-size: 1.125rem;
    font-weight: 600;
    margin: 0;
}

.admin-users__subtitle {
    margin: 6px 0 0;
    color: var(--text-secondary);
    font-size: 0.875rem;
}

.admin-users__meta {
    color: var(--text-secondary);
    font-size: 0.8125rem;
    white-space: nowrap;
}

.admin-users__loading,
.admin-users__error {
    color: var(--text-secondary);
    font-size: 0.875rem;
}

.users-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
}

.users-table th,
.users-table td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-color);
    text-align: left;
    vertical-align: middle;
}

.users-table th {
    font-weight: 600;
    color: var(--text-secondary);
    font-size: 0.8125rem;
}

.users-table__row {
    cursor: pointer;
    transition: background-color 0.15s ease;
}

.users-table__row:hover {
    background: color-mix(in srgb, var(--accent-color) 6%, transparent);
}

@media (max-width: 900px) {
    .admin-users {
        padding: 16px;
    }

    .admin-users__header {
        flex-direction: column;
    }

    .admin-users__meta {
        white-space: normal;
    }

    .filters-actions {
        justify-content: stretch;
    }

    .filters-actions .btn {
        flex: 1;
    }
}
</style>
