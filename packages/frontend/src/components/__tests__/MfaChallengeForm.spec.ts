import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MfaChallengeForm from '../auth/MfaChallengeForm.vue'
import en from '../../locales/en'

// feat-245 / feat-246 (docs/plan/passkeys-mfa-plan.md, Р4): the client side of a continuation.
// While the server answers `mfa_completion_pending` the form repeats the SAME verify request (a
// passkey answer is not replaced by a new ceremony); a passkey answer refused with
// `mfa_attempt_expired` asks for a new ceremony.

const { mfaVerifyMock, mfaWebauthnOptionsMock, usePasskeyMock, setRecoveryMock } = vi.hoisted(
    () => ({
        mfaVerifyMock: vi.fn(),
        mfaWebauthnOptionsMock: vi.fn(),
        usePasskeyMock: vi.fn(),
        setRecoveryMock: vi.fn(),
    }),
)

vi.mock('@/utils/api', () => ({
    authApi: { mfaVerify: mfaVerifyMock, mfaWebauthnOptions: mfaWebauthnOptionsMock },
}))
vi.mock('@/composables/usePasskeys', () => ({ usePasskey: usePasskeyMock }))
vi.mock('@/stores/user', () => ({ useUserStore: () => ({ setRecovery: setRecoveryMock }) }))

const USER = { id: '1', name: 'User', email: 'user@example.test' }
const success = { data: { status: 'success', user: USER }, error: null }
const failure = (reason: string) => ({
    data: { status: 'error', code: 'x', message: 'no', reason },
    error: null,
})
const pending = failure('mfa_completion_pending')
const OPTIONS = { data: { status: 'success', options: { challenge: 'c' } }, error: null }
const ASSERTION = { id: 'cred', response: {} }
const SECOND_ASSERTION = { id: 'cred', response: { second: true } }

const mountForm = (methods: ('webauthn' | 'totp' | 'recovery_code')[]) =>
    mount(MfaChallengeForm, {
        props: { methods },
        global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] },
    })

/** Submits and lets every pause between the pending retries pass. */
const submit = async (wrapper: ReturnType<typeof mountForm>) => {
    await wrapper.find('form').trigger('submit')
    for (let i = 0; i < 10; i++) {
        await flushPromises()
        await vi.runAllTimersAsync()
    }
    await flushPromises()
}

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
})

describe('MfaChallengeForm', () => {
    it('repeats a pending passkey answer, never a new ceremony, and signs in', async () => {
        mfaWebauthnOptionsMock.mockResolvedValue(OPTIONS)
        usePasskeyMock.mockResolvedValue({ ok: true, value: ASSERTION })
        mfaVerifyMock
            .mockResolvedValueOnce(pending)
            .mockResolvedValueOnce(pending)
            .mockResolvedValueOnce(success)
        const wrapper = mountForm(['webauthn', 'totp', 'recovery_code'])
        await submit(wrapper)
        expect(mfaVerifyMock).toHaveBeenCalledTimes(3)
        for (const [body] of mfaVerifyMock.mock.calls) {
            expect(body).toEqual({ method: 'webauthn', response: ASSERTION })
        }
        expect(usePasskeyMock).toHaveBeenCalledTimes(1)
        expect(wrapper.emitted('signed-in')).toEqual([[USER]])
    })

    it('after the pauses run out, "Try again" resends the same passkey answer', async () => {
        mfaWebauthnOptionsMock.mockResolvedValue(OPTIONS)
        usePasskeyMock.mockResolvedValue({ ok: true, value: ASSERTION })
        mfaVerifyMock.mockResolvedValue(pending)
        const wrapper = mountForm(['webauthn', 'totp', 'recovery_code'])
        await submit(wrapper)
        const sent = mfaVerifyMock.mock.calls.length
        expect(sent).toBe(6)
        expect(wrapper.find('[role="alert"]').text()).toBe(en.loginMfa.errorPending)
        expect(wrapper.find('[data-testid="mfa-submit"]').text()).toBe(en.loginMfa.retryPending)
        expect(wrapper.emitted('restart')).toBeUndefined()

        mfaVerifyMock.mockReset()
        mfaVerifyMock.mockResolvedValueOnce(success)
        await submit(wrapper)
        expect(mfaWebauthnOptionsMock).toHaveBeenCalledTimes(1)
        expect(usePasskeyMock).toHaveBeenCalledTimes(1)
        expect(mfaVerifyMock).toHaveBeenCalledWith({ method: 'webauthn', response: ASSERTION })
        expect(wrapper.emitted('signed-in')).toEqual([[USER]])
    })

    it('a network failure during the retry keeps the pending request', async () => {
        mfaWebauthnOptionsMock.mockResolvedValue(OPTIONS)
        usePasskeyMock.mockResolvedValue({ ok: true, value: ASSERTION })
        mfaVerifyMock.mockResolvedValue(pending)
        const wrapper = mountForm(['webauthn'])
        await submit(wrapper)

        mfaVerifyMock.mockReset()
        mfaVerifyMock.mockResolvedValueOnce({ data: null, error: { message: 'offline' } })
        await submit(wrapper)
        expect(wrapper.find('[data-testid="mfa-submit"]').text()).toBe(en.loginMfa.retryPending)

        mfaVerifyMock.mockResolvedValueOnce(success)
        await submit(wrapper)
        expect(usePasskeyMock).toHaveBeenCalledTimes(1)
        expect(mfaVerifyMock).toHaveBeenLastCalledWith({ method: 'webauthn', response: ASSERTION })
        expect(wrapper.emitted('signed-in')).toEqual([[USER]])
    })

    it('a rolled-back passkey answer (mfa_attempt_expired) runs a new ceremony next', async () => {
        mfaWebauthnOptionsMock.mockResolvedValue(OPTIONS)
        usePasskeyMock
            .mockResolvedValueOnce({ ok: true, value: ASSERTION })
            .mockResolvedValueOnce({ ok: true, value: SECOND_ASSERTION })
        mfaVerifyMock
            .mockResolvedValueOnce(pending)
            .mockResolvedValueOnce(failure('mfa_attempt_expired'))
        const wrapper = mountForm(['webauthn', 'totp', 'recovery_code'])
        await submit(wrapper)
        expect(wrapper.find('[role="alert"]').text()).toBe(en.loginMfa.errorPasskeyRetry)
        expect(wrapper.emitted('restart')).toBeUndefined()
        expect(wrapper.find('[data-testid="mfa-submit"]').text()).toBe(en.loginMfa.usePasskeyButton)

        mfaVerifyMock.mockResolvedValueOnce(success)
        await submit(wrapper)
        expect(mfaWebauthnOptionsMock).toHaveBeenCalledTimes(2)
        expect(mfaVerifyMock).toHaveBeenLastCalledWith({
            method: 'webauthn',
            response: SECOND_ASSERTION,
        })
        expect(wrapper.emitted('signed-in')).toEqual([[USER]])
    })

    it('options of a ticket that is finishing say so, not "sign in again"', async () => {
        mfaWebauthnOptionsMock.mockResolvedValue(pending)
        const wrapper = mountForm(['webauthn'])
        await submit(wrapper)
        expect(wrapper.find('[role="alert"]').text()).toBe(en.loginMfa.errorPending)
        expect(wrapper.emitted('restart')).toBeUndefined()
    })

    it('a TOTP continuation repeats the same code until it signs in', async () => {
        mfaVerifyMock.mockResolvedValue(pending)
        const wrapper = mountForm(['totp', 'recovery_code'])
        await wrapper.find('[data-testid="mfa-code"]').setValue('123456')
        await submit(wrapper)
        expect(mfaVerifyMock).toHaveBeenCalledTimes(6)

        // The field changed meanwhile: "Try again" still sends the request being finished.
        await wrapper.find('[data-testid="mfa-code"]').setValue('999999')
        mfaVerifyMock.mockReset()
        mfaVerifyMock.mockResolvedValueOnce(success)
        await submit(wrapper)
        expect(mfaVerifyMock).toHaveBeenCalledWith({ method: 'totp', code: '123456' })
        expect(wrapper.emitted('signed-in')).toEqual([[USER]])
    })

    it('a wrong code ends the pending state', async () => {
        mfaVerifyMock.mockResolvedValueOnce(pending).mockResolvedValueOnce(failure('invalid_code'))
        const wrapper = mountForm(['totp'])
        await wrapper.find('[data-testid="mfa-code"]').setValue('123456')
        await submit(wrapper)
        expect(wrapper.find('[role="alert"]').text()).toBe(en.loginMfa.errorCode)
        expect(wrapper.find('[data-testid="mfa-submit"]').text()).toBe(en.loginMfa.submit)
    })
})
