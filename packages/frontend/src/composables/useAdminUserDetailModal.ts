import { ref } from 'vue'
import { adminOnlineUsersApi } from '@/utils/api'
import type { AdminOnlineUserDetail } from 'shared/responses'

/**
 * The state of the "user details" modal the admin lists open: opening it loads the user, and
 * closing it forgets everything, so the next opening never shows the previous user.
 */
export function useAdminUserDetailModal() {
    const isModalOpen = ref(false)
    const selectedUser = ref<AdminOnlineUserDetail | null>(null)
    const detailLoading = ref(false)
    const detailError = ref<string | null>(null)

    async function openUserModal(userId: string): Promise<void> {
        isModalOpen.value = true
        detailLoading.value = true
        detailError.value = null
        selectedUser.value = null

        const res = await adminOnlineUsersApi.getById(userId)
        detailLoading.value = false

        if (res.data?.status === 'success') {
            selectedUser.value = res.data.user
            return
        }

        detailError.value = res.error?.message ?? 'Failed to load user details'
    }

    function closeModal(): void {
        isModalOpen.value = false
        selectedUser.value = null
        detailError.value = null
        detailLoading.value = false
    }

    return { isModalOpen, selectedUser, detailLoading, detailError, openUserModal, closeModal }
}
