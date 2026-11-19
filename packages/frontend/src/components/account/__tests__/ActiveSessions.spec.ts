import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionView } from 'shared'

import en from '@/locales/en'

// feat-233 (Р7–Р12): the session list of the account page, with the API and the socket replaced.

const api = vi.hoisted(() => ({
    listSessions: vi.fn(),
    revokeSession: vi.fn(),
    revokeOtherSessions: vi.fn(),
}))
const ws = vi.hoisted(() => ({
    websocketOpen: vi.fn(),
    suspendReconnect: vi.fn(),
    resumeReconnect: vi.fn(),
}))
vi.mock('@/utils/api', () => ({ accountApi: api }))
vi.mock('@/composables/useWebSocketConnection', () => ({ useWebSocketConnection: () => ws }))
vi.mock('@/stores/state', () => ({ useStateStore: () => ({ timeZone: 'UTC' }) }))

const { useEventBus } = await import('@/utils/event-bus')
const { default: ActiveSessions } = await import('../ActiveSessions.vue')

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
const eventBus = useEventBus()

const view = (id: string, over: Partial<SessionView> = {}): SessionView => ({
    id: id.padEnd(22, 'x'),
    current: false,
    browser: 'Firefox',
    os: 'Linux',
    deviceType: 'desktop',
    userAgent: 'Mozilla/5.0 Firefox',
    ip: '203.0.113.7',
    method: 'password',
    provider: null,
    signedInAt: '2026-11-19T10:00:00.000Z',
    lastSeenAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    online: false,
    ...over,
})
const CURRENT = view('current', { current: true, browser: 'Chrome', os: 'macOS', online: true })
const page = (
    others: SessionView[],
    nextCursor: string | null = null,
    current: SessionView | null = CURRENT,
) => ({
    data: { status: 'success', current, others, nextCursor },
    error: null,
})

const mounted: { unmount: () => void }[] = []
const render = async () => {
    const wrapper = mount(ActiveSessions, { global: { plugins: [i18n] }, attachTo: document.body })
    mounted.push(wrapper)
    await flushPromises()
    return wrapper
}

beforeEach(() => {
    vi.clearAllMocks()
    api.listSessions.mockResolvedValue(
        page([view('phone', { method: 'oauth', provider: 'github' })]),
    )
})
afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
})

describe('ActiveSessions', () => {
    it('shows this device and the others with device, IP, method and activity', async () => {
        const wrapper = await render()
        const current = wrapper.get('[data-testid="session-current"]')
        expect(current.text()).toContain('Chrome · macOS')
        expect(current.text()).toContain('This device')
        expect(current.find('[data-testid="session-online"]').exists()).toBe(true)
        expect(current.find('[data-testid="session-end"]').exists()).toBe(false)

        const other = wrapper.get('[data-testid="session-other"]')
        expect(other.text()).toContain('Firefox · Linux')
        expect(other.text()).toContain('IP address 203.0.113.7')
        expect(other.text()).toContain('GitHub')
        expect(other.text()).toContain('Active 3 h ago')
        expect(other.find('[data-testid="session-online"]').exists()).toBe(false)
        expect(wrapper.find('#sessions').exists()).toBe(true)
    })

    it('only the current session: the empty state, no "end all others"', async () => {
        api.listSessions.mockResolvedValue(page([]))
        const wrapper = await render()
        expect(wrapper.find('[data-testid="sessions-empty"]').exists()).toBe(true)
        expect(wrapper.find('[data-testid="sessions-end-others"]').exists()).toBe(false)
    })

    it('show more follows the cursor, past an empty page, without duplicates', async () => {
        api.listSessions
            .mockResolvedValueOnce(page([view('a')], 'c1'))
            .mockResolvedValueOnce(page([], 'c2', null))
            .mockResolvedValueOnce(page([view('a'), view('b')], null, null))
        const wrapper = await render()
        await wrapper.get('[data-testid="sessions-more"]').trigger('click')
        await flushPromises()
        expect(api.listSessions).toHaveBeenLastCalledWith('c1')
        // An empty page with a cursor keeps the button.
        expect(wrapper.find('[data-testid="sessions-empty"]').exists()).toBe(false)
        await wrapper.get('[data-testid="sessions-more"]').trigger('click')
        await flushPromises()
        expect(api.listSessions).toHaveBeenLastCalledWith('c2')
        expect(wrapper.findAll('[data-testid="session-other"]')).toHaveLength(2)
        expect(wrapper.find('[data-testid="sessions-more"]').exists()).toBe(false)
    })

    it('ends a session after its own confirmation; a 404 counts as done', async () => {
        const confirmSpy = vi.spyOn(window, 'confirm')
        api.revokeSession.mockResolvedValue({
            data: { status: 'error', code: 'not_found', message: 'Session not found' },
            error: { code: 'not_found', transportCode: 404, message: 'Session not found' },
        })
        const wrapper = await render()
        await wrapper.get('[data-testid="session-end"]').trigger('click')
        const dialog = document.querySelector('[data-testid="confirm-dialog"]')
        expect(dialog?.textContent).toContain('Firefox · Linux will be signed out at once.')
        document.querySelector<HTMLElement>('[data-testid="confirm-accept"]')!.click()
        await flushPromises()

        expect(api.revokeSession).toHaveBeenCalledWith(view('phone').id)
        expect(wrapper.find('[data-testid="session-other"]').exists()).toBe(false)
        expect(wrapper.get('[data-testid="sessions-notice"]').text()).toBe('The session was ended')
        expect(confirmSpy).not.toHaveBeenCalled()
    })

    it('cancelling the confirmation ends nothing', async () => {
        const wrapper = await render()
        await wrapper.get('[data-testid="session-end"]').trigger('click')
        document.querySelector<HTMLElement>('[data-testid="confirm-cancel"]')!.click()
        await flushPromises()
        expect(api.revokeSession).not.toHaveBeenCalled()
        expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull()
    })

    it('a stale answer during a renewal says "try again" and keeps the session', async () => {
        api.revokeSession.mockResolvedValue({
            data: null,
            error: { clientCode: 'session_renewed', transportCode: 401, message: 'Unauthorized' },
        })
        const wrapper = await render()
        await wrapper.get('[data-testid="session-end"]').trigger('click')
        document.querySelector<HTMLElement>('[data-testid="confirm-accept"]')!.click()
        await flushPromises()
        expect(wrapper.find('[data-testid="session-other"]').exists()).toBe(true)
        expect(wrapper.get('[data-testid="sessions-notice"]').text()).toContain('Try again')
    })

    it('ends all others: the button is off while in flight, the socket is replaced', async () => {
        let answer: (value: unknown) => void = () => undefined
        api.revokeOtherSessions.mockReturnValue(new Promise((resolve) => (answer = resolve)))
        const wrapper = await render()
        await wrapper.get('[data-testid="sessions-end-others"]').trigger('click')
        document.querySelector<HTMLElement>('[data-testid="confirm-accept"]')!.click()
        await flushPromises()
        expect(
            wrapper.get('[data-testid="sessions-end-others"]').attributes('disabled'),
        ).toBeDefined()
        expect(ws.suspendReconnect).toHaveBeenCalled()

        api.listSessions.mockResolvedValue(page([]))
        answer({
            data: {
                status: 'success',
                sessionRenewed: true,
                csrfToken: 'c',
                wsUrl: 'wss://x',
                wsToken: 'tok',
            },
            error: null,
        })
        await flushPromises()
        expect(ws.websocketOpen).toHaveBeenCalledWith('wss://x', 'tok')
        expect(ws.resumeReconnect).toHaveBeenCalled()
        expect(wrapper.find('[data-testid="session-other"]').exists()).toBe(false)
        expect(wrapper.get('[data-testid="sessions-notice"]').text()).toBe(
            'All other sessions were ended',
        )
    })

    it('ends all others without a renewal: the user is told to sign in again', async () => {
        const initApp = vi.fn()
        eventBus.on('init_app', initApp)
        api.revokeOtherSessions.mockResolvedValue({
            data: { status: 'success', sessionRenewed: false },
            error: null,
        })
        const wrapper = await render()
        await wrapper.get('[data-testid="sessions-end-others"]').trigger('click')
        document.querySelector<HTMLElement>('[data-testid="confirm-accept"]')!.click()
        await flushPromises()
        expect(initApp).toHaveBeenCalled()
        expect(ws.websocketOpen).not.toHaveBeenCalled()
        expect(wrapper.get('[data-testid="sessions-notice"]').text()).toContain('Sign in again')
        eventBus.off('init_app', initApp)
    })

    it('events close together are read once; ws_ready reads again too', async () => {
        vi.useFakeTimers()
        try {
            await render()
            expect(api.listSessions).toHaveBeenCalledTimes(1)
            eventBus.emit('user_sessions_changed', {})
            eventBus.emit('user_sessions_changed', {})
            eventBus.emit('ws_ready')
            await vi.advanceTimersByTimeAsync(299)
            expect(api.listSessions).toHaveBeenCalledTimes(1)
            await vi.advanceTimersByTimeAsync(1)
            expect(api.listSessions).toHaveBeenCalledTimes(2)
            expect(api.listSessions).toHaveBeenLastCalledWith()
        } finally {
            vi.useRealTimers()
        }
    })

    it('Redis down: says the sessions are unavailable, and retries on request', async () => {
        api.listSessions.mockResolvedValueOnce({
            data: null,
            error: { code: 'service_unavailable', transportCode: 503, message: 'down' },
        })
        const wrapper = await render()
        expect(wrapper.get('[data-testid="sessions-error"]').text()).toContain('unavailable')
        await wrapper.get('[data-testid="sessions-error"] button').trigger('click')
        await flushPromises()
        expect(wrapper.find('[data-testid="sessions-error"]').exists()).toBe(false)
        expect(wrapper.find('[data-testid="session-current"]').exists()).toBe(true)
    })

    it('shows activity to the hour', async () => {
        const minutes = (n: number) => new Date(Date.now() - n * 60_000).toISOString()
        api.listSessions.mockResolvedValue(
            page([
                view('a', { lastSeenAt: minutes(10) }),
                view('b', { lastSeenAt: minutes(26 * 60) }),
                view('c', { lastSeenAt: null }),
            ]),
        )
        const wrapper = await render()
        const texts = wrapper.findAll('[data-testid="session-other"]').map((w) => w.text())
        expect(texts[0]).toContain('Active less than an hour ago')
        expect(texts[1]).toContain('Active yesterday')
        expect(texts[2]).toContain('Activity unknown')
    })
})
