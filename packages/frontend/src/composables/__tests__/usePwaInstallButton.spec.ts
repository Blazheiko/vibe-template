import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive, ref, toRaw } from 'vue'
import { mount } from '@vue/test-utils'
import type { PwaInstallElement } from '../usePwaInstallButton'

// feat-076 (J): the "Install App" item of the menu: when it is offered, and what a click does.

const state = reactive({ isPWAMode: false, colorTheme: 'rose', darkMode: false })
vi.mock('@/stores/state', () => ({ useStateStore: () => state }))

const isInstallAvailable = ref(false)
const deferredPromptEvent = ref<unknown>(null)
const hasInstalledRelatedApp = ref(false)
const promptPwaInstall = vi.hoisted(() => vi.fn())
vi.mock('@/utils/pwa-install', () => ({
    usePwaInstallState: () => ({ isInstallAvailable, deferredPromptEvent, hasInstalledRelatedApp }),
    promptPwaInstall,
}))

const { resolveInstallAvailable, usePwaInstallButton } = await import('../usePwaInstallButton')

afterEach(() => {
    state.isPWAMode = false
    isInstallAvailable.value = false
    deferredPromptEvent.value = null
    hasInstalledRelatedApp.value = false
    promptPwaInstall.mockReset()
    vi.unstubAllGlobals()
})

describe('resolveInstallAvailable', () => {
    const base = {
        isAppInstalled: false,
        browserInstallAvailable: false,
        supportsNativeInstallPrompt: false,
        elementInstallAvailable: false,
    }

    it.each([
        [
            'installed beats everything',
            { ...base, isAppInstalled: true, browserInstallAvailable: true },
            false,
        ],
        ['the browser has a prompt ready', { ...base, browserInstallAvailable: true }, true],
        [
            'a Chromium browser without a prompt (yet): the element is not believed',
            { ...base, supportsNativeInstallPrompt: true, elementInstallAvailable: true },
            false,
        ],
        [
            'no native prompt at all (Safari): the element decides, yes',
            { ...base, elementInstallAvailable: true },
            true,
        ],
        ['no native prompt at all: the element decides, no', base, false],
    ])('%s', (_name, input, expected) => {
        expect(resolveInstallAvailable(input)).toBe(expected)
    })
})

function host(beforeInstall: () => void, withElement = true) {
    let api!: ReturnType<typeof usePwaInstallButton>
    const wrapper = mount(
        defineComponent({
            setup() {
                api = usePwaInstallButton(beforeInstall)
                return () =>
                    withElement
                        ? h('pwa-install', {
                              ref: api.pwaInstall as never,
                              style: api.pwaStyles.value,
                          })
                        : h('div')
            },
        }),
    )
    return { api, wrapper }
}

function elementOf(api: ReturnType<typeof usePwaInstallButton>): PwaInstallElement {
    const element = api.pwaInstall.value
    if (element === null) throw new Error('the element is not rendered')
    return element
}

describe('usePwaInstallButton', () => {
    it('offers the install while the browser has a prompt, and stops once the app is installed', () => {
        const { api, wrapper } = host(() => undefined)
        expect(api.isInstallAvailable.value).toBe(false)
        isInstallAvailable.value = true
        expect(api.isInstallAvailable.value).toBe(true)
        hasInstalledRelatedApp.value = true
        expect(api.isInstallAvailable.value).toBe(false)
        expect(api.shouldMountPwaInstall.value).toBe(false)
        wrapper.unmount()
    })

    it('does not offer it, and has no element, when the app runs as an installed one', () => {
        state.isPWAMode = true
        isInstallAvailable.value = true
        const { api, wrapper } = host(() => undefined)
        expect(api.isInstallAvailable.value).toBe(false)
        expect(api.shouldMountPwaInstall.value).toBe(false)
        wrapper.unmount()
    })

    it('a click closes the menu first, then uses the native prompt and never opens the dialog', async () => {
        const order: string[] = []
        promptPwaInstall.mockImplementation(() => {
            order.push('prompt')
            return Promise.resolve('accepted')
        })
        const { api, wrapper } = host(() => order.push('close'))
        await nextTick()
        const element = elementOf(api)
        const showDialog = vi.fn()
        element.showDialog = showDialog
        await api.installApp()
        expect(order).toEqual(['close', 'prompt'])
        expect(showDialog).not.toHaveBeenCalled()
        wrapper.unmount()
    })

    it('opens the dialog of the element when the browser had no prompt to use', async () => {
        promptPwaInstall.mockResolvedValue(null)
        const { api, wrapper } = host(() => undefined)
        await nextTick()
        const element = elementOf(api)
        const showDialog = vi.fn()
        element.showDialog = showDialog
        await api.installApp()
        expect(showDialog).toHaveBeenCalledTimes(1)
        wrapper.unmount()
    })

    it('listens to the element: where there is no native prompt it decides, and its success turns the item off', async () => {
        const { api, wrapper } = host(() => undefined)
        await nextTick()
        const element = elementOf(api)
        element.dispatchEvent(new Event('pwa-install-available-event'))
        expect(api.isInstallAvailable.value).toBe(true)
        element.dispatchEvent(new Event('pwa-install-success-event'))
        expect(api.isInstallAvailable.value).toBe(false)
        wrapper.unmount()
    })

    it('hands the element the prompt the browser gave, as it arrives', async () => {
        const { api, wrapper } = host(() => undefined)
        await nextTick()
        const event = { prompt: vi.fn() }
        deferredPromptEvent.value = event
        await nextTick()
        expect(toRaw(elementOf(api).externalPromptEvent)).toBe(event)
        wrapper.unmount()
    })

    it('styles the dialog with the accent of the theme, and again when the theme changes', async () => {
        document.documentElement.style.setProperty('--accent-color', ' #112233 ')
        const { api, wrapper } = host(() => undefined)
        expect(api.pwaStyles.value).toEqual({
            '--tint-color': '#112233',
            '--background-color-button': '#112233',
        })
        document.documentElement.style.setProperty('--accent-color', '#445566')
        state.darkMode = true
        await nextTick()
        expect(api.pwaStyles.value['--tint-color']).toBe('#445566')
        state.darkMode = false
        document.documentElement.style.removeProperty('--accent-color')
        await nextTick()
        expect(api.pwaStyles.value['--tint-color']).toBe('#A8627A')
        wrapper.unmount()
    })

    it('stops listening to the element when the component goes', async () => {
        const { api, wrapper } = host(() => undefined)
        await nextTick()
        const element = elementOf(api)
        const removed: string[] = []
        element.removeEventListener = (type: string) => {
            removed.push(type)
        }
        wrapper.unmount()
        expect(removed.filter((type) => type.startsWith('pwa-install'))).toEqual([
            'pwa-install-available-event',
            'pwa-install-success-event',
        ])
    })
})
