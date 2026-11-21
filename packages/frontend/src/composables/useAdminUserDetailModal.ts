import { ref, watch } from 'vue'
import { adminOnlineUsersApi } from '@/utils/api'
import { useUserStore } from '@/stores/user'
import type { AdminOnlineUserDetail } from 'shared/responses'

/**
 * The state of the "user details" modal the admin lists open: opening it loads the user, and
 * closing it forgets everything, so the next opening never shows the previous user.
 *
 * Review 2026-11-21 (feat-242): the details (phone, IP of the connections) need
 * users.sensitive.read. Losing it closes the modal, and the answer of a request started before —
 * or before another opening or a close — is dropped, so nothing read under the old rights shows.
 */
export function useAdminUserDetailModal() {
    const userStore = useUserStore()
    const isModalOpen = ref(false)
    const selectedUser = ref<AdminOnlineUserDetail | null>(null)
    const detailLoading = ref(false)
    const detailError = ref<string | null>(null)
    let request = 0

    async function openUserModal(userId: string): Promise<void> {
        if (!userStore.can('users.sensitive.read')) return
        request += 1
        const mine = request
        isModalOpen.value = true
        detailLoading.value = true
        detailError.value = null
        selectedUser.value = null

        const res = await adminOnlineUsersApi.getById(userId)
        if (mine !== request) return
        detailLoading.value = false

        if (res.data?.status === 'success') {
            selectedUser.value = res.data.user
            return
        }

        detailError.value = res.error?.message ?? 'Failed to load user details'
    }

    function closeModal(): void {
        request += 1
        isModalOpen.value = false
        selectedUser.value = null
        detailError.value = null
        detailLoading.value = false
    }

    watch(
        () => userStore.can('users.sensitive.read'),
        (may) => {
            if (!may) closeModal()
        },
    )

    return { isModalOpen, selectedUser, detailLoading, detailError, openUserModal, closeModal }
}
