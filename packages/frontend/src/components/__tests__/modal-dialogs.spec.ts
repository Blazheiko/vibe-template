import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en'
import pl from '@/locales/pl'
import uk from '@/locales/uk'

// feat-164 (review 2026-11-10): the three modals are dialogs for assistive technology and the
// keyboard; an icon-only button has a name. The behaviour itself is in useModalDialog.spec.ts.

vi.mock('vue-advanced-cropper', () => ({
    Cropper: { name: 'CropperStub', template: '<div class="cropper-stub" />' },
    CircleStencil: {},
}))
vi.mock('vue-advanced-cropper/dist/style.css', () => ({}))

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en, uk, pl } })

const mounted: { unmount: () => void }[] = []
const keep = <T extends { unmount: () => void }>(wrapper: T): T => {
    mounted.push(wrapper)
    return wrapper
}

const pressEscape = async (): Promise<void> => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
}

const labelOf = (dialog: Element): string | undefined => {
    const id = dialog.getAttribute('aria-labelledby')
    return id === null ? undefined : document.getElementById(id)?.textContent.trim()
}

describe('modal dialogs', () => {
    const createObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')

    beforeEach(() => {
        // jsdom has no object URLs.
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: () => 'blob:avatar',
        })
    })

    afterEach(() => {
        while (mounted.length > 0) mounted.pop()?.unmount()
        if (createObjectURL === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
        else Object.defineProperty(URL, 'createObjectURL', createObjectURL)
    })

    it('AuthModalShell: a labelled dialog that closes on Escape only while shown', async () => {
        const { default: AuthModalShell } = await import('../auth/AuthModalShell.vue')
        const wrapper = keep(
            mount(AuthModalShell, {
                props: { show: false, title: 'Sign In' },
                slots: { default: '<input id="field" />' },
                global: { plugins: [i18n] },
                attachTo: document.body,
            }),
        )
        const dialog = wrapper.find('[role="dialog"]')

        expect(dialog.attributes('aria-modal')).toBe('true')
        expect(labelOf(dialog.element)).toBe('Sign In')
        await pressEscape()
        expect(wrapper.emitted('close')).toBeUndefined()

        await wrapper.setProps({ show: true })
        await flushPromises()
        expect(document.activeElement?.id).toBe('field')

        await pressEscape()
        expect(wrapper.emitted('close')).toHaveLength(1)
    })

    it('AdminUserDetailModal: a labelled dialog, a named close button, Escape closes', async () => {
        const { default: AdminUserDetailModal } = await import('../admin/AdminUserDetailModal.vue')
        const wrapper = keep(
            mount(AdminUserDetailModal, {
                props: { open: true, loading: true, error: null, user: null },
                attachTo: document.body,
            }),
        )
        await flushPromises()
        const dialog = wrapper.find('[role="dialog"]')

        expect(dialog.attributes('aria-modal')).toBe('true')
        expect(labelOf(dialog.element)).toBe('User Details')
        expect(wrapper.find('.online-modal__close').attributes('aria-label')).toBe('Close')
        // Nothing but the close button can take focus while the details load.
        expect(document.activeElement).toBe(dialog.element)

        await pressEscape()
        expect(wrapper.emitted('close')).toHaveLength(1)
    })

    it('AvatarEditorModal: a labelled dialog, a named close button, Escape cancels', async () => {
        const { default: AvatarEditorModal } = await import('../AvatarEditorModal.vue')
        const wrapper = keep(
            mount(AvatarEditorModal, {
                props: { imageFile: new Blob(['x']) },
                global: { plugins: [i18n] },
                attachTo: document.body,
            }),
        )
        await flushPromises()
        const dialog = wrapper.find('[role="dialog"]')

        expect(dialog.attributes('aria-modal')).toBe('true')
        expect(labelOf(dialog.element)).toBe('Edit Avatar')
        expect(wrapper.find('.close-btn').attributes('aria-label')).toBe(
            en.account.avatar.closeEditor,
        )
        expect(dialog.element.contains(document.activeElement)).toBe(true)

        await pressEscape()
        expect(wrapper.emitted('cancel')).toHaveLength(1)
    })

    it('the names of the icon buttons exist in every locale', () => {
        for (const messages of [en, uk, pl]) {
            expect(messages.support.send).toMatch(/\S/)
            expect(messages.account.avatar.closeEditor).toMatch(/\S/)
        }
    })
})
