import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { afterEach, describe, expect, it, vi } from 'vitest'

import en from '@/locales/en'

// feat-236 (Р7): opening a notification needs nothing loaded — the answer carries the link.
const replace = vi.fn()
vi.mock('vue-router', () => ({
    useRoute: () => ({ params: { id: '41' } }),
    useRouter: () => ({ replace }),
}))
const markRead = vi.fn()
vi.mock('@/stores/notifications', () => ({ useNotificationsStore: () => ({ markRead }) }))

const { default: NotificationOpenView } = await import('../NotificationOpenView.vue')
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

const open = async () => {
    mount(NotificationOpenView, { global: { plugins: [i18n] } })
    await flushPromises()
}

afterEach(() => {
    vi.clearAllMocks()
})

describe('NotificationOpenView', () => {
    it('goes to the link, the fragment included', async () => {
        markRead.mockResolvedValue({ kind: 'read', link: '/account#sessions' })
        await open()
        expect(markRead).toHaveBeenCalledWith('41')
        expect(replace).toHaveBeenCalledWith('/account#sessions')
    })

    it('without a link, to the history', async () => {
        markRead.mockResolvedValue({ kind: 'read', link: null })
        await open()
        expect(replace).toHaveBeenCalledWith('/notifications')
    })

    it('a missing notification: the history with "gone"', async () => {
        markRead.mockResolvedValue({ kind: 'gone' })
        await open()
        expect(replace).toHaveBeenCalledWith({ path: '/notifications', query: { notice: 'gone' } })
    })

    it('an error: the history with "error"; the store reads again (its own spec)', async () => {
        markRead.mockResolvedValue({ kind: 'error' })
        await open()
        expect(replace).toHaveBeenCalledWith({ path: '/notifications', query: { notice: 'error' } })
    })
})
