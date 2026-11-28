import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en'
import uk from '@/locales/uk'
import PwaInstallButton from '../PwaInstallButton.vue'

const mountIn = (locale: 'en' | 'uk') =>
    mount(PwaInstallButton, {
        global: { plugins: [createI18n({ legacy: false, locale, messages: { en, uk } })] },
    })

// feat-076 (J): the item itself; it is the menu's `.menu-item` and styled by the menu.

describe('PwaInstallButton', () => {
    it('is one menu item that says "Install App" and tells the menu when it is clicked', async () => {
        const wrapper = mountIn('en')
        expect(wrapper.element.tagName).toBe('BUTTON')
        expect(wrapper.classes()).toEqual(['menu-item', 'install-app'])
        expect(wrapper.attributes('type')).toBe('button')
        expect(wrapper.text()).toBe('Install App')
        await wrapper.trigger('click')
        await wrapper.trigger('click')
        expect(wrapper.emitted('install')).toHaveLength(2)
    })

    it('is translated (feat-279)', () => {
        expect(mountIn('uk').text()).toBe('Встановити застосунок')
    })
})
