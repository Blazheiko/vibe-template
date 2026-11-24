import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MfaChallengeForm from '../auth/MfaChallengeForm.vue'
import en from '../../locales/en'

// feat-245 / feat-246 (docs/plan/passkeys-mfa-plan.md, Р4): the client side of a continuation.
// While the server answers `mfa_completion_pending` the form repeats the SAME verify request (a
// passkey answer is not replaced by a new ceremony); a passkey answer refused with
// `mfa_attempt_expired` asks for a new ceremony. Options answering `mfa_completion_pending` (the
// form lost the request) send `{ method: 'continue' }`; the other factors hide while pending.

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
/** feat-256: a submission's attemptId (a UUID). */
const ATTEMPT: unknown = expect.stringMatching(/^[\w-]{16,64}$/)

const mountForm = (methods: ('webauthn' | 'totp' | 'recovery_code')[], completing = false) =>
    mount(MfaChallengeForm, {
        props: { methods, completing },
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
            expect(body).toEqual({ method: 'webauthn', response: ASSERTION, attemptId: ATTEMPT })
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
        expect(mfaVerifyMock).toHaveBeenCalledWith({
            method: 'webauthn',
            response: ASSERTION,
            attemptId: ATTEMPT,
        })
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
        expect(mfaVerifyMock).toHaveBeenLastCalledWith({
            method: 'webauthn',
            response: ASSERTION,
            attemptId: ATTEMPT,
        })
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
            attemptId: ATTEMPT,
        })
        expect(wrapper.emitted('signed-in')).toEqual([[USER]])
    })

    it('options of a ticket that is finishing: continue, no ceremony, and signs in', async () => {
        // The answer of the confirmed passkey was lost (or the page reloaded): nothing is kept.
        mfaWebauthnOptionsMock.mockResolvedValue(pending)
        mfaVerifyMock.mockResolvedValueOnce(pending).mockResolvedValueOnce(success)
        const wrapper = mountForm(['webauthn', 'totp', 'recovery_code'])
        await submit(wrapper)
        expect(usePasskeyMock).not.toHaveBeenCalled()
        expect(mfaVerifyMock).toHaveBeenCalledTimes(2)
        for (const [body] of mfaVerifyMock.mock.calls) expect(body).toEqual({ method: 'continue' })
        expect(wrapper.emitted('signed-in')).toEqual([[USER]])
        expect(wrapper.emitted('restart')).toBeUndefined()
    })

    it('a continue still pending after the pauses: "Try again" sends continue again', async () => {
        mfaWebauthnOptionsMock.mockResolvedValue(pending)
        mfaVerifyMock.mockResolvedValue(pending)
        const wrapper = mountForm(['webauthn'])
        await submit(wrapper)
        expect(mfaVerifyMock).toHaveBeenCalledTimes(6)
        expect(wrapper.find('[role="alert"]').text()).toBe(en.loginMfa.errorPending)
        expect(wrapper.find('[data-testid="mfa-submit"]').text()).toBe(en.loginMfa.retryPending)

        mfaVerifyMock.mockReset()
        mfaVerifyMock.mockResolvedValueOnce(success)
        await submit(wrapper)
        expect(mfaWebauthnOptionsMock).toHaveBeenCalledTimes(1)
        expect(mfaVerifyMock).toHaveBeenCalledWith({ method: 'continue' })
        expect(wrapper.emitted('signed-in')).toEqual([[USER]])
    })

    it('a continue that finds the attempt rolled back asks for a new ceremony', async () => {
        mfaWebauthnOptionsMock.mockResolvedValueOnce(pending).mockResolvedValue(OPTIONS)
        usePasskeyMock.mockResolvedValue({ ok: true, value: ASSERTION })
        mfaVerifyMock.mockResolvedValueOnce(failure('mfa_attempt_expired'))
        const wrapper = mountForm(['webauthn', 'totp'])
        await submit(wrapper)
        expect(wrapper.find('[role="alert"]').text()).toBe(en.loginMfa.errorPasskeyRetry)
        expect(wrapper.find('[data-testid="mfa-submit"]').text()).toBe(en.loginMfa.usePasskeyButton)
        expect(wrapper.find('[data-testid="mfa-use-totp"]').exists()).toBe(true)

        mfaVerifyMock.mockResolvedValueOnce(success)
        await submit(wrapper)
        expect(usePasskeyMock).toHaveBeenCalledTimes(1)
        expect(mfaVerifyMock).toHaveBeenLastCalledWith({
            method: 'webauthn',
            response: ASSERTION,
            attemptId: ATTEMPT,
        })
        expect(wrapper.emitted('signed-in')).toEqual([[USER]])
    })

    it('hides the other factors while a completion is pending, shows them after', async () => {
        mfaWebauthnOptionsMock.mockResolvedValue(OPTIONS)
        usePasskeyMock.mockResolvedValue({ ok: true, value: ASSERTION })
        mfaVerifyMock.mockResolvedValue(pending)
        const wrapper = mountForm(['webauthn', 'totp', 'recovery_code'])
        expect(wrapper.find('[data-testid="mfa-use-totp"]').exists()).toBe(true)
        expect(wrapper.find('[data-testid="mfa-use-recovery"]').exists()).toBe(true)
        await submit(wrapper)
        expect(wrapper.find('[data-testid="mfa-submit"]').text()).toBe(en.loginMfa.retryPending)
        expect(wrapper.find('[data-testid="mfa-use-totp"]').exists()).toBe(false)
        expect(wrapper.find('[data-testid="mfa-use-recovery"]').exists()).toBe(false)

        // A final answer ends the pending state: the other factors come back.
        mfaVerifyMock.mockReset()
        mfaVerifyMock.mockResolvedValueOnce(failure('mfa_attempt_expired'))
        await submit(wrapper)
        expect(wrapper.find('[data-testid="mfa-use-totp"]').exists()).toBe(true)
        expect(wrapper.find('[data-testid="mfa-use-recovery"]').exists()).toBe(true)
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
        expect(mfaVerifyMock).toHaveBeenCalledWith({
            method: 'totp',
            code: '123456',
            attemptId: ATTEMPT,
        })
        expect(wrapper.emitted('signed-in')).toEqual([[USER]])
    })

    it('a recovery sign-in stores the recovery state of the answer before it signs in', async () => {
        const recovery = { expiresAt: '2026-11-22T12:15:00.000Z', replaced: false }
        const order: string[] = []
        setRecoveryMock.mockImplementation(() => order.push('recovery'))
        mfaVerifyMock.mockResolvedValueOnce({
            data: { status: 'success', user: USER, recovery },
            error: null,
        })
        const wrapper = mount(MfaChallengeForm, {
            props: {
                methods: ['totp', 'recovery_code'],
                onSignedIn: () => order.push('signed-in'),
            },
            global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] },
        })
        await wrapper.find('[data-testid="mfa-use-recovery"]').trigger('click')
        await wrapper.find('[data-testid="mfa-code"]').setValue('ABCD-EFGH')
        await submit(wrapper)
        expect(setRecoveryMock).toHaveBeenCalledWith(recovery)
        expect(order).toEqual(['recovery', 'signed-in'])
    })

    it('a continue that finishes a recovery ticket stores it too; an ordinary sign-in clears it', async () => {
        const recovery = { expiresAt: '2026-11-22T12:15:00.000Z', replaced: false }
        mfaWebauthnOptionsMock.mockResolvedValue(pending)
        mfaVerifyMock.mockResolvedValueOnce({
            data: { status: 'success', user: USER, recovery },
            error: null,
        })
        await submit(mountForm(['webauthn', 'recovery_code']))
        expect(mfaVerifyMock).toHaveBeenCalledWith({ method: 'continue' })
        expect(setRecoveryMock).toHaveBeenLastCalledWith(recovery)

        mfaVerifyMock.mockResolvedValueOnce(success)
        const wrapper = mountForm(['totp'])
        await wrapper.find('[data-testid="mfa-code"]').setValue('123456')
        await submit(wrapper)
        expect(setRecoveryMock).toHaveBeenLastCalledWith(null)
    })

    it('mounted for a completing ticket (after a reload): continue at once, and signs in', async () => {
        mfaVerifyMock.mockResolvedValueOnce(pending).mockResolvedValueOnce(success)
        const wrapper = mountForm(['totp', 'recovery_code'], true)
        for (let i = 0; i < 10; i++) {
            await flushPromises()
            await vi.runAllTimersAsync()
        }
        expect(mfaVerifyMock).toHaveBeenCalledTimes(2)
        for (const [body] of mfaVerifyMock.mock.calls) expect(body).toEqual({ method: 'continue' })
        expect(wrapper.emitted('signed-in')).toEqual([[USER]])
    })

    // Fourth review (H3): the first `continue` after a reload had nothing kept to repeat when its
    // answer was lost, and the form fell back to asking for the factor of a confirmed ticket.
    it('mounted for a completing ticket: a continue whose answer is lost stays pending', async () => {
        mfaVerifyMock.mockResolvedValueOnce({ data: null, error: { message: 'offline' } })
        const wrapper = mountForm(['totp', 'recovery_code'], true)
        for (let i = 0; i < 10; i++) {
            await flushPromises()
            await vi.runAllTimersAsync()
        }
        expect(wrapper.find('[data-testid="mfa-submit"]').text()).toBe(en.loginMfa.retryPending)
        expect(wrapper.find('[data-testid="mfa-use-recovery"]').exists()).toBe(false)

        mfaVerifyMock.mockResolvedValueOnce(success)
        await submit(wrapper)
        expect(mfaVerifyMock).toHaveBeenCalledTimes(2)
        for (const [body] of mfaVerifyMock.mock.calls) expect(body).toEqual({ method: 'continue' })
        expect(wrapper.emitted('signed-in')).toEqual([[USER]])
    })

    it('a code request whose first answer is lost is kept: "Try again" sends the same code', async () => {
        mfaVerifyMock.mockResolvedValueOnce({ data: null, error: { message: 'offline' } })
        const wrapper = mountForm(['totp', 'recovery_code'])
        await wrapper.find('[data-testid="mfa-code"]').setValue('123456')
        await submit(wrapper)
        expect(wrapper.find('[data-testid="mfa-submit"]').text()).toBe(en.loginMfa.retryPending)

        await wrapper.find('[data-testid="mfa-code"]').setValue('999999')
        mfaVerifyMock.mockResolvedValueOnce(success)
        await submit(wrapper)
        expect(mfaVerifyMock).toHaveBeenLastCalledWith({
            method: 'totp',
            code: '123456',
            attemptId: ATTEMPT,
        })
        expect(wrapper.emitted('signed-in')).toEqual([[USER]])
    })

    it('a 5xx without a reason keeps the request; a 4xx refusal drops it', async () => {
        mfaVerifyMock.mockResolvedValueOnce({
            data: { status: 'error', code: 'internal_error', message: 'no' },
            error: { code: 'internal_error', transportCode: 500, message: 'no' },
        })
        const wrapper = mountForm(['totp'])
        await wrapper.find('[data-testid="mfa-code"]').setValue('123456')
        await submit(wrapper)
        expect(wrapper.find('[data-testid="mfa-submit"]').text()).toBe(en.loginMfa.retryPending)

        mfaVerifyMock.mockResolvedValueOnce({
            data: { status: 'error', code: 'validation_error', message: 'no' },
            error: { code: 'validation_error', transportCode: 422, message: 'no' },
        })
        await submit(wrapper)
        expect(wrapper.find('[data-testid="mfa-submit"]').text()).toBe(en.loginMfa.submit)
    })

    it.each([
        [429, 'rate_limited', en.loginMfa.errorRateLimited],
        [408, 'request_timeout', en.loginMfa.errorPending],
    ])(
        'a %i keeps the request: "Try again" resends it without asking the factor again',
        async (status, code, message) => {
            mfaVerifyMock.mockResolvedValueOnce({
                data: { status: 'error', code, message: 'no' },
                error: { code, transportCode: status, message: 'no' },
            })
            const wrapper = mountForm(['totp', 'recovery_code'])
            await wrapper.find('[data-testid="mfa-code"]').setValue('123456')
            await submit(wrapper)
            expect(mfaVerifyMock).toHaveBeenCalledTimes(1)
            expect(wrapper.find('[data-testid="mfa-submit"]').text()).toBe(en.loginMfa.retryPending)
            expect(wrapper.find('[role="alert"]').text()).toBe(message)
            // The other factors stay hidden: the retry is the kept request.
            expect(wrapper.find('[data-testid="mfa-use-recovery"]').exists()).toBe(false)

            await wrapper.find('[data-testid="mfa-code"]').setValue('999999')
            mfaVerifyMock.mockResolvedValueOnce(success)
            await submit(wrapper)
            expect(mfaVerifyMock).toHaveBeenCalledTimes(2)
            expect(mfaVerifyMock).toHaveBeenLastCalledWith({
                method: 'totp',
                code: '123456',
                attemptId: ATTEMPT,
            })
            expect(wrapper.emitted('signed-in')).toEqual([[USER]])
        },
    )

    it('a rate-limited passkey answer is resent as it is, no new ceremony', async () => {
        mfaWebauthnOptionsMock.mockResolvedValue(OPTIONS)
        usePasskeyMock.mockResolvedValue({ ok: true, value: ASSERTION })
        mfaVerifyMock.mockResolvedValueOnce({
            data: { status: 'error', code: 'rate_limited', message: 'no' },
            error: { code: 'rate_limited', transportCode: 429, message: 'no' },
        })
        const wrapper = mountForm(['webauthn', 'totp'])
        await submit(wrapper)
        expect(wrapper.find('[role="alert"]').text()).toBe(en.loginMfa.errorRateLimited)

        mfaVerifyMock.mockResolvedValueOnce(success)
        await submit(wrapper)
        expect(usePasskeyMock).toHaveBeenCalledTimes(1)
        expect(mfaVerifyMock).toHaveBeenCalledTimes(2)
        for (const [body] of mfaVerifyMock.mock.calls) {
            expect(body).toEqual({ method: 'webauthn', response: ASSERTION, attemptId: ATTEMPT })
        }
        expect(wrapper.emitted('signed-in')).toEqual([[USER]])
    })

    it('mounted for an open ticket: nothing is sent until a proof is given', async () => {
        mountForm(['totp', 'recovery_code'])
        await flushPromises()
        expect(mfaVerifyMock).not.toHaveBeenCalled()
    })

    it('a wrong code ends the pending state', async () => {
        mfaVerifyMock.mockResolvedValueOnce(pending).mockResolvedValueOnce(failure('invalid_code'))
        const wrapper = mountForm(['totp'])
        await wrapper.find('[data-testid="mfa-code"]').setValue('123456')
        await submit(wrapper)
        expect(wrapper.find('[role="alert"]').text()).toBe(en.loginMfa.errorCode)
        expect(wrapper.find('[data-testid="mfa-submit"]').text()).toBe(en.loginMfa.submit)
    })

    // feat-256 (docs/plan/mfa-review-fixes-7-plan.md, item 6).
    it('a repeat after a 503 is the same attempt; a new submission of the same code is a new one', async () => {
        const unavailable = {
            data: { status: 'error', code: 'service_unavailable', message: 'down' },
            error: { code: 'service_unavailable', transportCode: 503, message: 'down' },
        }
        mfaVerifyMock
            .mockResolvedValueOnce(unavailable)
            .mockResolvedValueOnce(failure('invalid_code'))
            .mockResolvedValueOnce(failure('invalid_code'))
        const wrapper = mountForm(['totp', 'recovery_code'])
        await wrapper.find('[data-testid="mfa-code"]').setValue('123456')
        await submit(wrapper)
        // "Try again" after the 503 sends the kept request: the same attempt.
        await submit(wrapper)
        // The same code typed and sent again: a new attempt.
        await wrapper.find('[data-testid="mfa-code"]').setValue('123456')
        await submit(wrapper)
        const ids = mfaVerifyMock.mock.calls.map(
            ([body]) => (body as { attemptId: string }).attemptId,
        )
        expect(ids).toHaveLength(3)
        expect(ids[1]).toBe(ids[0])
        expect(ids[2]).not.toBe(ids[0])
    })

    // feat-258 (docs/plan/mfa-review-fixes-7-plan.md, 8.3).
    it.each(['session_unverified', 'account_changed'] as const)(
        'a 403 the client could not repeat (%s) keeps the request: "Try again" sends the same one',
        async (clientCode) => {
            const unanswered = {
                data: {
                    status: 'error',
                    code: 'csrf_invalid',
                    message: 'CSRF token mismatch',
                    reason: 'token_mismatch',
                },
                error: { code: 'csrf_invalid', transportCode: 403, message: 'x', clientCode },
            }
            mfaVerifyMock.mockResolvedValueOnce(unanswered).mockResolvedValueOnce(success)
            const wrapper = mountForm(['totp', 'recovery_code'])
            await wrapper.find('[data-testid="mfa-code"]').setValue('123456')
            await submit(wrapper)
            expect(wrapper.find('[data-testid="mfa-submit"]').text()).toBe(en.loginMfa.retryPending)
            await submit(wrapper)
            const [first, second] = mfaVerifyMock.mock.calls.map(([body]) => body as unknown)
            expect(second).toEqual(first)
            expect(wrapper.emitted('signed-in')).toEqual([[USER]])
        },
    )
})
