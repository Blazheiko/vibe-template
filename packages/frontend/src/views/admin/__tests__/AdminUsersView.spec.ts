import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminUserListItem } from 'shared/responses'

import { useUserStore } from '@/stores/user'

// feat-242 (review 2026-11-21): the users list keeps the answer of the current filters only, and a
// role change refreshes the selection of the role filter.

const api = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/utils/api', () => ({ adminUsersApi: api, adminOnlineUsersApi: { getById: vi.fn() } }))
vi.mock('@/stores/state', () => ({ useStateStore: () => ({ timeZone: 'UTC' }) }))

const { default: AdminUsersView } = await import('../AdminUsersView.vue')

const user = (id: string, over: Partial<AdminUserListItem> = {}): AdminUserListItem => ({
    id,
    name: `User ${id}`,
    email: `u${id}@example.test`,
    registeredAt: '2026-11-20T10:00:00.000Z',
    role: 'user',
    emailVerified: true,
    ...over,
})
const page = (items: AdminUserListItem[], total = items.length) => ({
    data: { status: 'success', items, total, nextCursor: null, hasMore: false },
})

const mountView = async () => {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }],
    })
    const wrapper = mount(AdminUsersView, {
        global: {
            plugins: [router],
            stubs: { RoleChangeDialog: true, AdminUserDetailModal: true },
        },
    })
    await flushPromises()
    return wrapper
}

const ids = (wrapper: Awaited<ReturnType<typeof mountView>>) =>
    wrapper.findAll('.cell-id').map((cell) => cell.text())

describe('AdminUsersView', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        useUserStore().setUser({ id: '1', role: 'admin' })
        api.list.mockReset()
    })

    it('drops the answer of the filters before the role filter changed', async () => {
        api.list.mockResolvedValueOnce(page([user('2'), user('3', { role: 'kb_editor' })]))
        const wrapper = await mountView()

        let answerOld: (value: unknown) => void = () => undefined
        api.list.mockReturnValueOnce(
            new Promise((resolve) => {
                answerOld = resolve
            }),
        )
        await wrapper.find('form').trigger('submit')
        api.list.mockResolvedValueOnce(page([user('3', { role: 'kb_editor' })], 1))
        await wrapper.find('select[name="role"]').setValue('kb_editor')
        await flushPromises()

        answerOld(page([user('2'), user('3'), user('4')], 3))
        await flushPromises()

        expect(ids(wrapper)).toEqual(['3'])
        expect(wrapper.text()).toContain('Loaded: 1 / 1')
    })

    it('a row whose new role no longer matches the role filter leaves the list', async () => {
        api.list.mockResolvedValueOnce(page([user('2')]))
        const wrapper = await mountView()
        api.list.mockResolvedValueOnce(
            page([user('3', { role: 'kb_editor' }), user('4', { role: 'kb_editor' })], 2),
        )
        await wrapper.find('select[name="role"]').setValue('kb_editor')
        await flushPromises()

        await wrapper.findAll('.role-btn')[0]?.trigger('click')
        wrapper.findComponent({ name: 'RoleChangeDialog' }).vm.$emit('changed', 'support_operator')
        await flushPromises()

        expect(ids(wrapper)).toEqual(['4'])
        expect(wrapper.text()).toContain('Loaded: 1 / 1')
    })

    it('without a role filter the row shows its new role', async () => {
        api.list.mockResolvedValueOnce(page([user('2')]))
        const wrapper = await mountView()

        await wrapper.find('.role-btn').trigger('click')
        wrapper.findComponent({ name: 'RoleChangeDialog' }).vm.$emit('changed', 'kb_editor')
        await flushPromises()

        expect(ids(wrapper)).toEqual(['2'])
        expect(wrapper.find('.cell-role').text()).toBe('Knowledge base editor')
    })
})
