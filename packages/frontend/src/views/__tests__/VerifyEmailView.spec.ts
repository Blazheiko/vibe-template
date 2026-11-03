import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import VerifyEmailView from '../VerifyEmailView.vue'
import en from '../../locales/en'

// feat-097: a registration link opened without a session of its account asks for the account's
// password; a wrong password keeps the form (the link is not used up).

const { verifyEmailMock, initMock, routeQuery, store } = vi.hoisted(() => {
    const routeQuery: { value: Record<string, unknown> } = { value: { token: 'tok' } }
    const store: { user: null | { id: string }; setUser: ReturnType<typeof vi.fn> } = {
        user: null,
        setUser: vi.fn(),
    }
    return { verifyEmailMock: vi.fn(), initMock: vi.fn(), routeQuery, store }
})

vi.mock('@/utils/api', () => ({
    authApi: { verifyEmail: verifyEmailMock },
    mainApi: { init: initMock },
}))
vi.mock('@/stores/user', () => ({ useUserStore: () => store }))
vi.mock('vue-router', () => ({
    useRoute: () => ({ query: routeQuery.value }),
    useRouter: () => ({ push: vi.fn() }),
}))

const ok = (message = 'Email verified successfully') => ({
    data: { status: 'success', message },
    error: null,
})
const fail = (status: number, reason: string | undefined, message = 'refused') => ({
    data: {
        status: 'error',
        code: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'bad_request',
        message,
        ...(reason === undefined ? {} : { reason }),
    },
    error: { message, transportCode: status },
})

const mountView = async () => {
    const wrapper = mount(VerifyEmailView, {
        global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] },
    })
    await flushPromises()
    return wrapper
}

describe('VerifyEmailView', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        routeQuery.value = { token: 'tok' }
        store.user = null
    })

    it('confirms with the token alone when the server needs nothing more', async () => {
        verifyEmailMock.mockResolvedValueOnce(ok())
        const wrapper = await mountView()

        expect(verifyEmailMock).toHaveBeenCalledExactlyOnceWith({ token: 'tok' })
        expect(wrapper.find('h1').text()).toBe(en.emailVerification.successTitle)
        expect(wrapper.find('input[type="password"]').exists()).toBe(false)
    })

    it('shows a password field on 403 password_required and resubmits with it', async () => {
        verifyEmailMock
            .mockResolvedValueOnce(fail(403, 'password_required'))
            .mockResolvedValueOnce(ok())
        const wrapper = await mountView()

        expect(wrapper.text()).toContain(en.emailVerification.passwordPrompt)
        const input = wrapper.find('input[type="password"]')
        expect(input.attributes('autocomplete')).toBe('current-password')
        await input.setValue('secret-pass')
        await wrapper.find('form').trigger('submit')
        await flushPromises()

        expect(verifyEmailMock).toHaveBeenLastCalledWith({ token: 'tok', password: 'secret-pass' })
        expect(wrapper.find('h1').text()).toBe(en.emailVerification.successTitle)
    })

    it('says the password is incorrect on 400 invalid_password and keeps the form', async () => {
        verifyEmailMock
            .mockResolvedValueOnce(fail(403, 'password_required'))
            .mockResolvedValueOnce(fail(400, 'invalid_password', 'Password is incorrect'))
        const wrapper = await mountView()

        await wrapper.find('input[type="password"]').setValue('wrong')
        await wrapper.find('form').trigger('submit')
        await flushPromises()

        expect(wrapper.find('[role="alert"]').text()).toBe(en.emailVerification.passwordIncorrect)
        expect(wrapper.find('input[type="password"]').exists()).toBe(true)
    })

    it('does not send an empty password', async () => {
        verifyEmailMock.mockResolvedValueOnce(fail(403, 'password_required'))
        const wrapper = await mountView()

        await wrapper.find('form').trigger('submit')
        await flushPromises()

        expect(verifyEmailMock).toHaveBeenCalledOnce()
        expect(wrapper.find('[role="alert"]').text()).toBe(en.emailVerification.passwordEmpty)
    })

    it('explains a link opened outside the account that asked for it', async () => {
        verifyEmailMock.mockResolvedValueOnce(fail(403, 'email_link_wrong_session'))
        const wrapper = await mountView()

        expect(wrapper.find('h1').text()).toBe(en.emailVerification.errorTitle)
        expect(wrapper.text()).toContain(en.emailVerification.wrongSession)
    })

    it('explains a revoked session', async () => {
        verifyEmailMock.mockResolvedValueOnce(fail(401, 'session_revoked'))
        const wrapper = await mountView()

        expect(wrapper.text()).toContain(en.emailVerification.sessionRevoked)
    })

    it('shows the server message for any other refusal', async () => {
        verifyEmailMock.mockResolvedValueOnce(fail(400, undefined, 'Verification link has expired'))
        const wrapper = await mountView()

        expect(wrapper.text()).toContain('Verification link has expired')
    })

    it('refreshes the signed-in user after a confirmation', async () => {
        store.user = { id: '1' }
        verifyEmailMock.mockResolvedValueOnce(ok())
        initMock.mockResolvedValueOnce({
            data: { status: 'ok', user: { id: '1', email: 'jane@example.com' } },
            error: null,
        })
        await mountView()

        expect(store.setUser).toHaveBeenCalledWith({ id: '1', email: 'jane@example.com' })
    })
})
