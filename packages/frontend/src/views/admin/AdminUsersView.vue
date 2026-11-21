<script setup lang="ts">
import { useDateFormat } from '@/composables/useDateFormat'
import { computed, onMounted, ref } from 'vue'
import { ROLES, type Role } from 'shared/access'
import RoleChangeDialog from '@/components/admin/RoleChangeDialog.vue'
import { useUserStore } from '@/stores/user'
import { ROLE_LABELS, canChangeRoleOf } from '@/views/admin/role-options'
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

const PAGE_LIMIT = 100

const users = ref<AdminUserListItem[]>([])
const total = ref(0)
// feat-155: the list is paged by the id of the last user shown.
const nextCursor = ref<string | null>(null)
const hasMore = ref(false)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref<string | null>(null)
const { isModalOpen, selectedUser, detailLoading, detailError, openUserModal, closeModal } =
    useAdminUserDetailModal()

// feat-241 (Р10): the role column and filter; the change-role action needs users.roles.assign and
// a target the delegation policy allows. The detail needs users.sensitive.read (feat-240), the
// history audit.read.account.
const userStore = useUserStore()
const roleFilter = ref<Role | ''>('')
const canOpenDetail = computed(() => userStore.can('users.sensitive.read'))
const canReadLog = computed(() => userStore.can('audit.read.account'))
const roleTarget = ref<AdminUserListItem | null>(null)

function mayChangeRole(user: AdminUserListItem): boolean {
    const me = userStore.user
    if (me === null || !userStore.can('users.roles.assign')) return false
    return canChangeRoleOf({ id: me.id, role: me.role }, user)
}

function openDetail(id: string) {
    if (canOpenDetail.value) void openUserModal(id)
}

// feat-242 (review 2026-11-21): the list shown is the selection of the role filter; a row whose new
// role no longer matches it leaves the list at once. feat-243 (second review): a page asked for
// before the change would bring the old row or total back, so the change starts a new generation
// and reads the current selection again, without hiding the table meanwhile.
function onRoleChanged(role: Role) {
    const target = roleTarget.value
    roleTarget.value = null
    if (target === null) return
    if (roleFilter.value !== '' && roleFilter.value !== role) {
        const before = users.value.length
        users.value = users.value.filter((user) => user.id !== target.id)
        if (users.value.length < before) total.value = Math.max(0, total.value - 1)
    } else {
        users.value = users.value.map((user) => (user.id === target.id ? { ...user, role } : user))
    }
    void loadUsers(true, { quiet: true })
}

const filters = ref<UserFilters>({
    userId: '',
    dateFrom: '',
    dateTo: '',
})

// feat-242 (review 2026-11-21): every first page starts a new generation; the answer of an older
// one (a page of the filters before the change) is dropped instead of replacing the list, the
// total and the cursor.
let generation = 0

/**
 * The first page (`reset`), or the next one after what is shown. `quiet` re-reads the first page
 * keeping the list on screen until the answer, and on a failure.
 */
async function loadUsers(reset = true, { quiet = false }: { quiet?: boolean } = {}) {
    if (reset) {
        generation += 1
        loading.value = !quiet
        loadingMore.value = false
    } else {
        loadingMore.value = true
    }
    const mine = generation
    error.value = null

    const cursor = reset ? undefined : (nextCursor.value ?? undefined)
    const res = await adminUsersApi.list({
        limit: PAGE_LIMIT,
        ...(cursor !== undefined ? { cursor } : {}),
        userId: filters.value.userId,
        dateFrom: filters.value.dateFrom,
        dateTo: filters.value.dateTo,
        ...(roleFilter.value !== '' ? { role: roleFilter.value } : {}),
    })
    if (mine !== generation) return

    loading.value = false
    loadingMore.value = false

    if (res.data?.status === 'success') {
        users.value = reset ? res.data.items : [...users.value, ...res.data.items]
        total.value = res.data.total
        nextCursor.value = res.data.nextCursor
        hasMore.value = res.data.hasMore
        return
    }

    // A failed next page or quiet re-read keeps what is shown; a failed first page shows nothing.
    if (reset && !quiet) {
        users.value = []
        total.value = 0
        nextCursor.value = null
        hasMore.value = false
    }
    error.value = getResponseMessage(res.data, res.error?.message ?? 'Failed to load users')
}

function resetFilters() {
    filters.value = {
        userId: '',
        dateFrom: '',
        dateTo: '',
    }
    roleFilter.value = ''
    void loadUsers()
}

// feat-232 (Р8): in the time zone of the profile, or of the browser.
const { formatDateTime: formatDate } = useDateFormat()

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
            @submit="loadUsers()"
            @reset="resetFilters"
        />

        <label class="admin-users__role-filter">
            <span>Role</span>
            <select v-model="roleFilter" name="role" @change="loadUsers()">
                <option value="">Any role</option>
                <option v-for="role in ROLES" :key="role" :value="role">
                    {{ ROLE_LABELS[role] }}
                </option>
            </select>
        </label>

        <div v-if="loading" class="admin-users__loading">Loading users...</div>
        <div v-else-if="error !== null && users.length === 0" class="admin-users__error">
            {{ error }}
        </div>

        <div v-else class="table-wrap">
            <table class="users-table">
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Name</th>
                        <th>Email</th>
                        <th>Registered At</th>
                        <th>Role</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    <tr
                        v-for="user in users"
                        :key="user.id"
                        class="users-table__row"
                        :class="{ 'users-table__row--static': !canOpenDetail }"
                        @click="openDetail(user.id)"
                    >
                        <td class="cell-id">{{ user.id }}</td>
                        <td>{{ user.name }}</td>
                        <td class="cell-email">{{ user.email }}</td>
                        <td>{{ formatDate(user.registeredAt) }}</td>
                        <td class="cell-role">{{ ROLE_LABELS[user.role] }}</td>
                        <td class="cell-actions">
                            <button
                                v-if="mayChangeRole(user)"
                                type="button"
                                class="role-btn"
                                @click.stop="roleTarget = user"
                            >
                                Change role
                            </button>
                            <!-- feat-235: what was done to this account, in the audit log. -->
                            <router-link
                                v-if="canReadLog"
                                class="audit-link"
                                :to="{ path: '/admin/audit-log', query: { targetUserId: user.id } }"
                                @click.stop
                            >
                                Log
                            </router-link>
                        </td>
                    </tr>
                    <tr v-if="users.length === 0">
                        <td colspan="6" class="empty-row">No users found</td>
                    </tr>
                </tbody>
            </table>

            <div v-if="error !== null" class="admin-users__error">{{ error }}</div>

            <div v-if="hasMore" class="load-more-wrap">
                <button
                    class="load-more-btn"
                    type="button"
                    :disabled="loadingMore"
                    @click="loadUsers(false)"
                >
                    {{ loadingMore ? 'Loading...' : 'Load more' }}
                </button>
            </div>
        </div>

        <AdminUserDetailModal
            :open="isModalOpen"
            :loading="detailLoading"
            :error="detailError"
            :user="selectedUser"
            @close="closeModal"
        />
        <RoleChangeDialog
            v-if="userStore.user?.role !== undefined"
            :open="roleTarget !== null"
            :actor-role="userStore.user.role"
            :target="roleTarget"
            @close="roleTarget = null"
            @changed="onRoleChanged"
        />
    </div>
</template>

<style scoped>
.admin-users__role-filter {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 16px;
    font-size: 0.875rem;
}

.users-table__row--static {
    cursor: default;
}

.cell-actions {
    display: flex;
    gap: 8px;
    align-items: center;
}

.role-btn {
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid var(--border-color);
    background: transparent;
    color: inherit;
    font-size: 0.8125rem;
    cursor: pointer;
}

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
.audit-link {
    color: var(--accent-color);
    font-size: 0.8125rem;
}

.load-more-wrap {
    display: flex;
    justify-content: center;
    margin-top: 20px;
}

.load-more-btn {
    appearance: none;
    border: 1px solid var(--accent-color);
    background: var(--accent-color);
    color: white;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
}

.load-more-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-color) 88%, black);
}

.load-more-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}
</style>
