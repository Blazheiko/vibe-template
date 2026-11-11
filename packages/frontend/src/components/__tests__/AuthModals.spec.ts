import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AuthModals from '../AuthModals.vue'
import en from '../../locales/en'

const {
    loginMock,
    forgotPasswordMock,
    startPhonePasswordResetMock,
    completePhonePasswordResetMock,
    registerEmailMock,
    registerPhoneStartMock,
    registerPhoneConfirmMock,
    registerPhoneCompleteMock,
    setUserMock,
    pushMock,
    eventBusEmitMock,
} = vi.hoisted(() => ({
    loginMock: vi.fn(),
    forgotPasswordMock: vi.fn(),
    startPhonePasswordResetMock: vi.fn(),
    completePhonePasswordResetMock: vi.fn(),
    registerEmailMock: vi.fn(),
    registerPhoneStartMock: vi.fn(),
    registerPhoneConfirmMock: vi.fn(),
    registerPhoneCompleteMock: vi.fn(),
    setUserMock: vi.fn(),
    pushMock: vi.fn(),
    eventBusEmitMock: vi.fn(),
}))

vi.mock('@/utils/api', () => ({
    authApi: {
        getOAuthProviders: vi.fn().mockResolvedValue({ data: null, error: null }),
        login: loginMock,
        forgotPassword: forgotPasswordMock,
        startPhonePasswordReset: startPhonePasswordResetMock,
        completePhonePasswordReset: completePhonePasswordResetMock,
        registerEmail: registerEmailMock,
        registerPhoneStart: registerPhoneStartMock,
        registerPhoneConfirm: registerPhoneConfirmMock,
        registerPhoneComplete: registerPhoneCompleteMock,
    },
}))

vi.mock('@/stores/user', () => ({
    useUserStore: () => ({
        setUser: setUserMock,
        user: null,
    }),
}))

vi.mock('@/utils/event-bus', () => ({
    useEventBus: () => ({
        emit: eventBusEmitMock,
    }),
}))

vi.mock('vue-router', () => ({
    useRoute: () => ({
        query: {},
    }),
    useRouter: () => ({
        push: pushMock,
    }),
}))

function createWrapper(props: Record<string, unknown>) {
    const i18n = createI18n({
        legacy: false,
        locale: 'en',
        messages: { en },
    })

    return mount(AuthModals, {
        props,
        global: {
            plugins: [i18n],
        },
    })
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('VITE_AUTH_PHONE_ENABLED', 'true')
})

describe('AuthModals', () => {
    const visibleModal = (wrapper: ReturnType<typeof createWrapper>) =>
        wrapper.get('.modal-overlay.show')

    it('keeps the legacy email registration screen when phone auth is disabled', async () => {
        vi.stubEnv('VITE_AUTH_PHONE_ENABLED', 'false')
        registerEmailMock.mockResolvedValue({
            data: {
                status: 'success',
                message:
                    'If the email can be used for registration, continue with the verification instructions sent to your inbox.',
            },
            error: null,
        })

        const wrapper = createWrapper({ showLogin: false, showRegister: true })

        const modal = visibleModal(wrapper)

        await modal.get('#register-name').setValue('Jane')
        await modal.get('#register-email').setValue('jane@example.com')
        await modal.get('#register-password').setValue('secret123')
        await modal.get('#register-password-confirm').setValue('secret123')
        await modal.get('input[type="checkbox"]').setValue(true)
        await modal.get('button.auth-button').trigger('click')
        await flushPromises()

        expect(registerEmailMock).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'Jane',
                email: 'jane@example.com',
                password: 'secret123',
            }),
        )
        expect(setUserMock).not.toHaveBeenCalled()
        expect(pushMock).not.toHaveBeenCalled()
        expect(modal.text()).toContain(
            'If the email can be used for registration, continue with the verification instructions sent to your inbox.',
        )
    })

    it('shows the backend generic registration message when email signup succeeds without logging in', async () => {
        vi.stubEnv('VITE_AUTH_PHONE_ENABLED', 'false')
        registerEmailMock.mockResolvedValue({
            data: {
                status: 'success',
                message:
                    'If the email can be used for registration, continue with the verification instructions sent to your inbox.',
            },
            error: null,
        })

        const wrapper = createWrapper({ showLogin: false, showRegister: true })
        const modal = visibleModal(wrapper)

        await modal.get('#register-name').setValue('Jane')
        await modal.get('#register-email').setValue('jane@example.com')
        await modal.get('#register-password').setValue('secret123')
        await modal.get('#register-password-confirm').setValue('secret123')
        await modal.get('input[type="checkbox"]').setValue(true)
        await modal.get('button.auth-button').trigger('click')
        await flushPromises()

        expect(setUserMock).not.toHaveBeenCalled()
        expect(modal.text()).toContain(
            'If the email can be used for registration, continue with the verification instructions sent to your inbox.',
        )
    })

    it('authenticates immediately when email signup returns an auth payload', async () => {
        vi.stubEnv('VITE_AUTH_PHONE_ENABLED', 'false')
        const user = {
            id: '7',
            name: 'Jane',
            email: 'jane@example.com',
            emailVerified: false,
            emailVerifiedAt: null,
        }
        registerEmailMock.mockResolvedValue({
            data: {
                status: 'success',
                user,
                wsUrl: 'wss://example.com/ws',
                wsToken: 'ws-token',
            },
            error: null,
        })

        const wrapper = createWrapper({ showLogin: false, showRegister: true })
        const modal = visibleModal(wrapper)

        await modal.get('#register-name').setValue('Jane')
        await modal.get('#register-email').setValue('jane@example.com')
        await modal.get('#register-password').setValue('secret123')
        await modal.get('#register-password-confirm').setValue('secret123')
        await modal.get('input[type="checkbox"]').setValue(true)
        await modal.get('button.auth-button').trigger('click')
        await flushPromises()

        expect(setUserMock).toHaveBeenCalledWith(user)
        expect(wrapper.emitted('close')).toBeTruthy()
        expect(wrapper.emitted('auth-success')).toBeTruthy()
        expect(pushMock).toHaveBeenCalledWith({ name: 'UserAccount' })
        expect(eventBusEmitMock).toHaveBeenCalledWith('init_app')
        expect(modal.text()).not.toContain(
            'If the email can be used for registration, continue with the verification instructions sent to your inbox.',
        )
    })

    it('logs in with a single identifier field', async () => {
        loginMock.mockResolvedValue({
            data: {
                status: 'success',
                user: {
                    id: '2',
                    name: 'Jane',
                    email: 'jane@example.com',
                    emailVerified: true,
                },
                wsUrl: '',
                wsToken: '',
            },
            error: null,
        })

        const wrapper = createWrapper({ showLogin: true, showRegister: false })

        const modal = visibleModal(wrapper)

        await modal.get('#login-identifier').setValue('jane@example.com')
        await modal.get('#login-password').setValue('secret123')
        await modal.get('button.auth-button').trigger('click')
        await flushPromises()

        expect(loginMock).toHaveBeenCalledWith({
            identifier: 'jane@example.com',
            password: 'secret123',
        })
        expect(setUserMock).toHaveBeenCalled()
        expect(eventBusEmitMock).toHaveBeenCalledWith('init_app')
    })

    it('walks through the phone registration flow', async () => {
        registerPhoneStartMock.mockResolvedValue({
            data: {
                status: 'success',
                challengeId: 'challenge-1',
                expiresAt: '2026-05-15T12:00:00.000Z',
                resendAvailableAt: '2026-05-15T11:20:00.000Z',
            },
            error: null,
        })
        registerPhoneConfirmMock.mockResolvedValue({
            data: {
                status: 'success',
                challengeId: 'challenge-1',
                verified: true,
            },
            error: null,
        })
        registerPhoneCompleteMock.mockResolvedValue({
            data: {
                status: 'success',
                user: {
                    id: '3',
                    name: 'Jane',
                    phone: '+15551234567',
                    emailVerified: false,
                },
                wsUrl: '',
                wsToken: '',
            },
            error: null,
        })

        const wrapper = createWrapper({ showLogin: false, showRegister: true })

        const modal = visibleModal(wrapper)

        await modal.get('button.auth-button.secondary').trigger('click')
        await flushPromises()
        await modal.get('#register-phone').setValue('+15551234567')
        await modal.get('#register-phone-country').setValue('US')
        await modal.get('button.auth-button').trigger('click')
        await flushPromises()

        expect(registerPhoneStartMock).toHaveBeenCalledWith({
            phone: '+15551234567',
            defaultCountry: 'US',
        })

        await modal.get('#register-phone-code').setValue('123456')
        await modal.get('button.auth-button').trigger('click')
        await flushPromises()

        expect(registerPhoneConfirmMock).toHaveBeenCalledWith({
            challengeId: 'challenge-1',
            code: '123456',
        })

        await modal.get('#register-phone-name').setValue('Jane')
        await modal.get('#register-phone-password').setValue('secret123')
        await modal.get('#register-phone-password-confirm').setValue('secret123')
        await modal.get('input[type="checkbox"]').setValue(true)
        await modal.get('button.auth-button').trigger('click')
        await flushPromises()

        expect(registerPhoneCompleteMock).toHaveBeenCalledWith(
            expect.objectContaining({
                challengeId: 'challenge-1',
                name: 'Jane',
                password: 'secret123',
            }),
        )
        expect(setUserMock).toHaveBeenCalled()
        expect(wrapper.emitted('auth-success')).toBeTruthy()
    })

    it('starts and completes the phone recovery flow without calling the email reset endpoint', async () => {
        startPhonePasswordResetMock.mockResolvedValue({
            data: {
                status: 'success',
                message:
                    'If the phone number can be used for password reset, verification instructions will be sent shortly.',
                challengeId: 'reset-challenge-1',
                expiresAt: '2026-05-15T12:00:00.000Z',
                resendAvailableAt: '2026-05-15T11:20:00.000Z',
            },
            error: null,
        })
        completePhonePasswordResetMock.mockResolvedValue({
            data: {
                status: 'success',
                message: 'Password reset successfully',
            },
            error: null,
        })

        const wrapper = createWrapper({ showLogin: true, showRegister: false })

        const modal = visibleModal(wrapper)

        await modal.get('a.forgot-password').trigger('click')
        await modal.get('#forgot-identifier').setValue('+15551234567')
        await modal.get('button.auth-button').trigger('click')
        await flushPromises()

        expect(forgotPasswordMock).not.toHaveBeenCalled()
        expect(startPhonePasswordResetMock).toHaveBeenCalledWith({
            phone: '+15551234567',
        })
        expect(modal.get('#forgot-phone-code')).toBeTruthy()

        await modal.get('#forgot-phone-code').setValue('123456')
        await modal.get('#forgot-phone-password').setValue('new-password')
        await modal.get('#forgot-phone-password-confirm').setValue('new-password')
        await modal.get('button.auth-button').trigger('click')
        await flushPromises()

        expect(completePhonePasswordResetMock).toHaveBeenCalledWith({
            challengeId: 'reset-challenge-1',
            code: '123456',
            password: 'new-password',
            passwordConfirm: 'new-password',
        })
    })
})
