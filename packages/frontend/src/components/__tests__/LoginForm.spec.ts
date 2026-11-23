import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LoginForm from '../auth/LoginForm.vue'
import en from '../../locales/en'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р4): the second step of a password sign-in lives only
// in memory. After a reload the form asks POST /auth/mfa/state before a new sign-in and, for a
// ticket of this browser, shows the second step again instead of the password form.

const { mfaStateMock, mfaVerifyMock, loginMock } = vi.hoisted(() => ({
    mfaStateMock: vi.fn(),
    mfaVerifyMock: vi.fn(),
    loginMock: vi.fn(),
}))

vi.mock('@/utils/api', () => ({
    authApi: {
        getOAuthProviders: vi.fn().mockResolvedValue({ data: null, error: null }),
        mfaState: mfaStateMock,
        mfaVerify: mfaVerifyMock,
        mfaWebauthnOptions: vi.fn(),
        login: loginMock,
    },
}))
vi.mock('@/composables/usePasskeys', () => ({
    passkeysSupported: () => Promise.resolve(false),
    passkeyAutofillSupported: () => Promise.resolve(false),
    usePasskey: vi.fn(),
}))
vi.mock('@/composables/useCompleteSignIn', () => ({ useCompleteSignIn: () => vi.fn() }))
vi.mock('@/stores/user', () => ({ useUserStore: () => ({ setRecovery: vi.fn() }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

const mountForm = (active = true) =>
    mount(LoginForm, {
        props: { notice: '', identifier: '', password: '', active },
        global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] },
    })

afterEach(() => {
    vi.clearAllMocks()
})

describe('LoginForm after a reload', () => {
    it('a ticket of this browser: the second step comes back with its methods', async () => {
        mfaStateMock.mockResolvedValue({
            data: { status: 'mfa_required', methods: ['totp', 'recovery_code'] },
            error: null,
        })
        const wrapper = mountForm()
        await flushPromises()
        expect(mfaStateMock).toHaveBeenCalledTimes(1)
        expect(wrapper.find('[data-testid="mfa-challenge"]').exists()).toBe(true)
        expect(wrapper.find('#login-password').exists()).toBe(false)
        expect(wrapper.find('[data-testid="mfa-use-recovery"]').exists()).toBe(true)
        // An open ticket: nothing sent until a code is given.
        expect(mfaVerifyMock).not.toHaveBeenCalled()
    })

    it('a completing ticket: the form continues it at once', async () => {
        mfaStateMock.mockResolvedValue({
            data: { status: 'mfa_required', methods: ['totp', 'recovery_code'], completing: true },
            error: null,
        })
        mfaVerifyMock.mockResolvedValue({
            data: { status: 'success', user: { id: '1', name: 'U', email: 'u@example.test' } },
            error: null,
        })
        const wrapper = mountForm()
        await flushPromises()
        expect(mfaVerifyMock).toHaveBeenCalledWith({ method: 'continue' })
        expect(wrapper.find('[data-testid="mfa-challenge"]').exists()).toBe(true)
    })

    it('no ticket (or an error): the password form', async () => {
        mfaStateMock.mockResolvedValueOnce({ data: { status: 'none' }, error: null })
        const wrapper = mountForm()
        await flushPromises()
        expect(wrapper.find('#login-password').exists()).toBe(true)
        expect(wrapper.find('[data-testid="mfa-challenge"]').exists()).toBe(false)

        mfaStateMock.mockResolvedValueOnce({ data: null, error: { message: 'offline' } })
        const offline = mountForm()
        await flushPromises()
        expect(offline.find('#login-password').exists()).toBe(true)
    })

    it('a hidden modal asks nothing until it is shown', async () => {
        mfaStateMock.mockResolvedValue({ data: { status: 'none' }, error: null })
        const wrapper = mountForm(false)
        await flushPromises()
        expect(mfaStateMock).not.toHaveBeenCalled()
        await wrapper.setProps({ active: true })
        await flushPromises()
        expect(mfaStateMock).toHaveBeenCalledTimes(1)
    })
})
