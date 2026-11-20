import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { reactive, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import en from '@/locales/en'

// feat-236 (Р11): the bell — badge, "99+", "mark all read", and every way the panel closes calls
// closeList exactly once, so a closed panel never keeps the list "open".

const route = reactive({ fullPath: '/' })
vi.mock('vue-router', () => ({
    useRoute: () => route,
    RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
}))
vi.mock('@/stores/state', () => ({ useStateStore: () => ({ timeZone: 'UTC' }) }))

const store = reactive({
    unreadCount: 0,
    badge: '0',
    items: [] as unknown[],
    loaded: true,
    loadFailed: false,
    unreadOnly: false,
    openList: vi.fn(),
    closeList: vi.fn(),
    markAllRead: vi.fn(),
    setUnreadOnly: vi.fn(),
})
vi.mock('@/stores/notifications', () => ({ useNotificationsStore: () => store }))

const { default: NotificationBell } = await import('../NotificationBell.vue')
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

const mounted = ref<{ unmount: () => void }[]>([])
const render = () => {
    const wrapper = mount(NotificationBell, {
        global: { plugins: [i18n], stubs: { RouterLink: { template: '<a><slot /></a>' } } },
        attachTo: document.body,
    })
    mounted.value.push(wrapper)
    return wrapper
}

afterEach(() => {
    for (const wrapper of mounted.value) wrapper.unmount()
    mounted.value = []
    vi.clearAllMocks()
    Object.assign(store, { unreadCount: 0, badge: '0', items: [] })
})

describe('NotificationBell', () => {
    it('shows the badge only with unread notifications, capped as the store says', async () => {
        const wrapper = render()
        expect(wrapper.find('[data-testid="notification-badge"]').exists()).toBe(false)
        Object.assign(store, { unreadCount: 100, badge: '99+' })
        await flushPromises()
        expect(wrapper.get('[data-testid="notification-badge"]').text()).toBe('99+')
    })

    it.each([
        [
            'the bell again',
            (w: ReturnType<typeof render>): Promise<void> =>
                w.get('[data-testid="notification-bell"]').trigger('click'),
        ],
        [
            'Escape',
            (): Promise<void> => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
                return Promise.resolve()
            },
        ],
        [
            'a click outside',
            (): Promise<void> => {
                document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                return Promise.resolve()
            },
        ],
        [
            'another route',
            (): Promise<void> => {
                route.fullPath = `/elsewhere-${String(Math.random())}`
                return flushPromises().then(() => undefined)
            },
        ],
        [
            'unmounting',
            (w: ReturnType<typeof render>): Promise<void> => {
                w.unmount()
                mounted.value = mounted.value.filter((m) => m !== w)
                return Promise.resolve()
            },
        ],
    ])('closing by %s calls closeList once', async (_label, close) => {
        const wrapper = render()
        await wrapper.get('[data-testid="notification-bell"]').trigger('click')
        expect(store.openList).toHaveBeenCalledOnce()
        expect(wrapper.find('[data-testid="notification-panel"]').exists()).toBe(true)

        await close(wrapper)
        await flushPromises()
        expect(store.closeList).toHaveBeenCalledOnce()

        // Nothing closes twice: a later unmount or Escape does not call it again.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        expect(store.closeList).toHaveBeenCalledOnce()
    })

    it('"mark all read" asks the store', async () => {
        Object.assign(store, { unreadCount: 2, badge: '2', items: [] })
        store.items = [
            {
                id: '5',
                kind: 'support.reply',
                category: 'support',
                params: {},
                link: '/support',
                createdAt: '2026-11-20T10:00:00.000Z',
                readAt: null,
            },
        ]
        const wrapper = render()
        await wrapper.get('[data-testid="notification-bell"]').trigger('click')
        await wrapper.get('[data-testid="notifications-mark-all"]').trigger('click')
        expect(store.markAllRead).toHaveBeenCalledOnce()
        expect(wrapper.text()).toContain('Support replied')
    })
})
