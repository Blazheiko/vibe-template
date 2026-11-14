import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import OAuthLinkConfirmView from '../OAuthLinkConfirmView.vue'
import en from '../../locales/en'

// feat-097: the page of the mailed link that confirms an OAuth sign-in into an existing account.

const { confirmMock, replaceMock, emitMock, resetReadyMock, routeQuery } = vi.hoisted(() => {
    const routeQuery: { value: Record<string, unknown> } = { value: { token: 'tok' } }
    return {
        confirmMock: vi.fn(),
        replaceMock: vi.fn(),
        emitMock: vi.fn(),
        resetReadyMock: vi.fn(),
        routeQuery,
    }
})

vi.mock('@/utils/api', () => ({ authApi: { confirmOAuthLink: confirmMock } }))
vi.mock('@/stores/user', () => ({ useUserStore: () => ({ resetReady: resetReadyMock }) }))
vi.mock('@/utils/event-bus', () => ({ useEventBus: () => ({ emit: emitMock }) }))
vi.mock('vue-router', () => ({
    useRoute: () => ({ path: '/oauth/link/confirm', query: routeQuery.value }),
    useRouter: () => ({ push: vi.fn(), replace: replaceMock }),
}))

const fail = (status: number, reason: string | undefined, message = 'refused') => ({
    data: { status: 'error', code: 'bad_request', message, ...(reason ? { reason } : {}) },
    error: { message, transportCode: status },
})

const mountView = async () => {
    const wrapper = mount(OAuthLinkConfirmView, {
        global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] },
    })
    await flushPromises()
    return wrapper
}

describe('OAuthLinkConfirmView', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        routeQuery.value = { token: 'tok' }
    })

    it('confirms the link, re-reads the session and opens the account', async () => {
        confirmMock.mockResolvedValueOnce({ data: { status: 'success' }, error: null })
        const wrapper = await mountView()

        expect(confirmMock).toHaveBeenCalledExactlyOnceWith({ token: 'tok' })
        expect(wrapper.find('h1').text()).toBe(en.oauthLink.successTitle)
        expect(resetReadyMock).toHaveBeenCalledOnce()
        expect(emitMock).toHaveBeenCalledWith('init_app')
        expect(replaceMock).toHaveBeenCalledWith({ name: 'UserAccount' })
    })

    it('sends nothing without a token', async () => {
        routeQuery.value = {}
        const wrapper = await mountView()

        expect(confirmMock).not.toHaveBeenCalled()
        expect(wrapper.text()).toContain(en.oauthLink.invalid)
    })

    it.each([
        [403, 'oauth_link_wrong_session', en.oauthLink.wrongSession],
        [400, 'used_token', en.oauthLink.used],
        [400, 'expired_token', en.oauthLink.expired],
        [400, 'invalid_token', en.oauthLink.invalid],
        [409, 'email_changed', en.oauthLink.emailChanged],
        [409, 'oauth_already_linked', en.oauthLink.alreadyLinked],
    ])('explains %i %s', async (status, reason, text) => {
        confirmMock.mockResolvedValueOnce(fail(status, reason))
        const wrapper = await mountView()

        expect(wrapper.find('h1').text()).toBe(en.oauthLink.errorTitle)
        expect(wrapper.find('[role="alert"]').text()).toBe(text)
        expect(emitMock).not.toHaveBeenCalled()
        expect(replaceMock).not.toHaveBeenCalled()
    })

    it('shows a generic message for a server or network failure', async () => {
        confirmMock.mockResolvedValueOnce(fail(500, undefined, 'Internal Server Error'))
        const wrapper = await mountView()

        expect(wrapper.find('[role="alert"]').text()).toBe(en.oauthLink.failed)
    })
})
