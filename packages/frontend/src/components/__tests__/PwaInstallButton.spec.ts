import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PwaInstallButton from '../PwaInstallButton.vue'

// feat-076 (J): the item itself; it is the menu's `.menu-item` and styled by the menu.

describe('PwaInstallButton', () => {
    it('is one menu item that says "Install App" and tells the menu when it is clicked', async () => {
        const wrapper = mount(PwaInstallButton)
        expect(wrapper.element.tagName).toBe('BUTTON')
        expect(wrapper.classes()).toEqual(['menu-item', 'install-app'])
        expect(wrapper.attributes('type')).toBe('button')
        expect(wrapper.text()).toBe('Install App')
        await wrapper.trigger('click')
        await wrapper.trigger('click')
        expect(wrapper.emitted('install')).toHaveLength(2)
    })
})
