import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import en from '@/locales/en'

// feat-236 (Р4, Р11): the channel matrix — a locked cell cannot change, a refused change is put
// back, and the matrix is read again on ws_ready and when another tab changed it.
const api = vi.hoisted(() => ({ getPreferences: vi.fn(), updatePreference: vi.fn() }))
vi.mock('@/utils/api', () => ({ notificationsApi: api }))

const { useEventBus } = await import('@/utils/event-bus')
const { default: NotificationPreferences } = await import('../NotificationPreferences.vue')
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

const MATRIX = [
    { category: 'security', channel: 'push', enabled: true, locked: false },
    { category: 'security', channel: 'email', enabled: true, locked: true },
    { category: 'support', channel: 'push', enabled: true, locked: false },
]
const ok = (preferences: unknown) => ({ data: { status: 'success', preferences }, error: null })

const mounted: { unmount: () => void }[] = []
const render = async () => {
    const wrapper = mount(NotificationPreferences, { global: { plugins: [i18n] } })
    mounted.push(wrapper)
    await flushPromises()
    return wrapper
}
const box = (wrapper: Awaited<ReturnType<typeof render>>, id: string) =>
    wrapper.get(`[data-testid="preference-${id}"] input`)

beforeEach(() => {
    api.getPreferences.mockResolvedValue(ok(MATRIX))
})
afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
    vi.clearAllMocks()
})

describe('NotificationPreferences', () => {
    it('a locked channel is shown on and disabled', async () => {
        const wrapper = await render()
        const email = box(wrapper, 'security-email').element as HTMLInputElement
        expect(email.checked).toBe(true)
        expect(email.disabled).toBe(true)
        expect(wrapper.get('[data-testid="preference-security-email"]').text()).toContain(
            'Always on for security',
        )
    })

    it('turns a channel off, and the answer replaces the matrix', async () => {
        const wrapper = await render()
        const updated = MATRIX.map((cell) =>
            cell.category === 'support' ? { ...cell, enabled: false } : cell,
        )
        api.updatePreference.mockResolvedValue(ok(updated))

        await box(wrapper, 'support-push').trigger('change')
        await flushPromises()

        expect(api.updatePreference).toHaveBeenCalledWith({
            category: 'support',
            channel: 'push',
            enabled: false,
        })
        expect((box(wrapper, 'support-push').element as HTMLInputElement).checked).toBe(false)
    })

    it('a refused change is put back with a message', async () => {
        const wrapper = await render()
        api.updatePreference.mockResolvedValue({ data: null, error: { transportCode: 500 } })

        await box(wrapper, 'support-push').trigger('change')
        await flushPromises()

        expect((box(wrapper, 'support-push').element as HTMLInputElement).checked).toBe(true)
        expect(wrapper.text()).toContain('Could not save the setting')
    })

    it('reads again on ws_ready and on a change from another tab', async () => {
        await render()
        api.getPreferences.mockClear()
        useEventBus().emit('ws_ready')
        useEventBus().emit('notification_preferences_changed', {})
        await flushPromises()
        expect(api.getPreferences).toHaveBeenCalledTimes(2)
    })
})
