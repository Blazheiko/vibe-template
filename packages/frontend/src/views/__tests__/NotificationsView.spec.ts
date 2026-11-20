import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { reactive } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import en from '@/locales/en'

// feat-236 (Р11): the history page counts as an open list while mounted, has the two tabs and
// "show more", and shows the notice of an opening that failed.
const route = reactive({ query: {} })
vi.mock('vue-router', () => ({ useRoute: () => route }))
vi.mock('@/stores/state', () => ({ useStateStore: () => ({ timeZone: 'UTC' }) }))

const store = reactive({
    unreadCount: 1,
    badge: '1',
    items: [
        {
            id: '3',
            kind: 'security.new_sign_in',
            category: 'security',
            params: { device: 'Chrome on macOS' },
            link: '/account#sessions',
            createdAt: '2026-11-20T10:00:00.000Z',
            readAt: null,
        },
    ],
    next: '3',
    loaded: true,
    loadFailed: false,
    loadingMore: false,
    unreadOnly: false,
    openList: vi.fn(),
    closeList: vi.fn(),
    setUnreadOnly: vi.fn(),
    loadMore: vi.fn(),
    markAllRead: vi.fn(),
    readNow: vi.fn(),
})
vi.mock('@/stores/notifications', () => ({ useNotificationsStore: () => store }))

const { default: NotificationsView } = await import('../NotificationsView.vue')
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
const render = () =>
    mount(NotificationsView, {
        global: { plugins: [i18n], stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    })

afterEach(() => {
    vi.clearAllMocks()
    route.query = {}
})

describe('NotificationsView', () => {
    it('opens the list on mount and closes it on unmount, once each', () => {
        const wrapper = render()
        expect(store.openList).toHaveBeenCalledOnce()
        wrapper.unmount()
        expect(store.closeList).toHaveBeenCalledOnce()
    })

    it('renders the text of the kind with its params', () => {
        const wrapper = render()
        expect(wrapper.text()).toContain('Signed in from Chrome on macOS.')
    })

    it('switches tabs and loads more through the store', async () => {
        const wrapper = render()
        await wrapper.get('[data-testid="notifications-tab-unread"]').trigger('click')
        expect(store.setUnreadOnly).toHaveBeenCalledWith(true)
        await wrapper.get('[data-testid="notifications-more"]').trigger('click')
        expect(store.loadMore).toHaveBeenCalledOnce()
    })

    it.each(['gone', 'error'])('shows the %s notice of a failed opening', async (notice) => {
        route.query = { notice }
        const wrapper = render()
        await flushPromises()
        expect(wrapper.get('[data-testid="notifications-notice"]').text()).toBe(
            en.notifications.notice[notice as 'gone' | 'error'],
        )
    })
})
