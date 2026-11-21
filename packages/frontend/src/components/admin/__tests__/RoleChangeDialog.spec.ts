import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const setRole = vi.hoisted(() => vi.fn())
vi.mock('@/utils/api', () => ({ adminUsersApi: { setRole } }))

const { default: RoleChangeDialog } = await import('../RoleChangeDialog.vue')

// feat-241 (Р10): the dialog sends the chosen role and reports the server's answer.
const target = { id: '9', name: 'Ann', role: 'user' as const, emailVerified: true }

const mountDialog = (actorRole: 'admin' | 'user_admin' = 'user_admin') =>
    mount(RoleChangeDialog, {
        props: { open: true, actorRole, target },
        attachTo: document.body,
    })

describe('RoleChangeDialog', () => {
    beforeEach(() => {
        setRole.mockReset()
    })

    it('offers the roles of the delegation policy and sends the chosen one', async () => {
        setRole.mockResolvedValue({
            data: { status: 'success', user: { id: '9', role: 'kb_editor' }, changed: true },
            error: null,
        })
        const wrapper = mountDialog()
        const values = wrapper.findAll('input[type="radio"]').map((input) => input.element.value)
        expect(values).toEqual(['support_operator', 'kb_editor'])

        await wrapper.find('input[value="kb_editor"]').setValue(true)
        await wrapper
            .findAll('button')
            .find((button) => button.text() === 'Change role')
            ?.trigger('click')
        await flushPromises()

        expect(setRole).toHaveBeenCalledWith('9', 'kb_editor')
        expect(wrapper.emitted('changed')).toEqual([['kb_editor']])
        wrapper.unmount()
    })

    it('shows the reason of a refusal and stays open', async () => {
        setRole.mockResolvedValue({
            data: {
                status: 'error',
                code: 'conflict',
                reason: 'identity_unverified',
                message: 'A staff role needs a verified email',
            },
            error: { message: 'conflict', code: 'conflict', transportCode: 409 },
        })
        const wrapper = mountDialog('admin')

        await wrapper.find('input[value="support_operator"]').setValue(true)
        await wrapper
            .findAll('button')
            .find((button) => button.text() === 'Change role')
            ?.trigger('click')
        await flushPromises()

        expect(wrapper.find('[role="alert"]').text()).toBe('A staff role needs a verified email.')
        expect(wrapper.emitted('changed')).toBeUndefined()
        wrapper.unmount()
    })
})
