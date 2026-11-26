import { effectScope, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useUserStore } from '@/stores/user'
import { asEntityId, testUser } from '../../__tests__/brands'

// feat-242 (review 2026-11-21): the details of a user (phone, IP) need users.sensitive.read;
// losing it hides them, and an answer started under the old rights is dropped.

const api = vi.hoisted(() => ({ getById: vi.fn() }))
vi.mock('@/utils/api', () => ({ adminOnlineUsersApi: api }))

const { useAdminUserDetailModal } = await import('../useAdminUserDetailModal')

const detail = { id: '7', name: 'Bob', phone: '+380000000000' }
const answer = { data: { status: 'success', user: detail } }

const setup = () => {
    const scope = effectScope()
    const modal = scope.run(() => useAdminUserDetailModal())
    if (modal === undefined) throw new Error('no modal')
    return modal
}

describe('useAdminUserDetailModal', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        useUserStore().setUser(testUser({ id: asEntityId('1'), role: 'admin' }))
        api.getById.mockReset()
    })

    it('closes an open detail when users.sensitive.read is lost', async () => {
        api.getById.mockResolvedValue(answer)
        const modal = setup()
        await modal.openUserModal('7')
        expect(modal.selectedUser.value).toEqual(detail)

        useUserStore().applyAccessChanged('support_operator')
        await nextTick()

        expect(modal.isModalOpen.value).toBe(false)
        expect(modal.selectedUser.value).toBeNull()
    })

    it('drops an answer that arrives after the permission was lost', async () => {
        let resolve: (value: unknown) => void = () => undefined
        api.getById.mockReturnValue(
            new Promise((done) => {
                resolve = done
            }),
        )
        const modal = setup()
        const pending = modal.openUserModal('7')

        useUserStore().applyAccessChanged('support_operator')
        await nextTick()
        resolve(answer)
        await pending

        expect(modal.isModalOpen.value).toBe(false)
        expect(modal.selectedUser.value).toBeNull()
    })

    it('opens nothing without users.sensitive.read', async () => {
        useUserStore().setUser(testUser({ id: asEntityId('1'), role: 'support_operator' }))
        const modal = setup()
        await modal.openUserModal('7')
        expect(api.getById).not.toHaveBeenCalled()
        expect(modal.isModalOpen.value).toBe(false)
    })
})
