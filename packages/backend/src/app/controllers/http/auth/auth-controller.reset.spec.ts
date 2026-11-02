import { Result } from 'better-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { badRequest } from '#app/services/shared/errors.js'

// feat-092: the password reset controllers end with respond(); the reason of a refused
// reset and the optional fields of a phone reset start pass through unchanged.

const { resetPassword, startPhonePasswordReset } = vi.hoisted(() => ({
    resetPassword: vi.fn(),
    startPhonePasswordReset: vi.fn(),
}))

vi.mock('#app/services/auth/auth-service.js', () => ({ authService: {} }))
vi.mock('#app/services/auth/email-verification-service.js', () => ({
    emailVerificationService: {},
}))
vi.mock('#app/services/auth/password-reset-service.js', () => ({
    passwordResetService: { resetPassword, startPhonePasswordReset },
    GENERIC_RESET_MESSAGE: '',
}))

const { default: AuthController } = await import('./auth-controller.js')

const createContext = (payload: Record<string, unknown>) =>
    ({
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
        httpData: { payload, ip: '10.0.0.1' },
        responseData: { status: 200, setHeader: vi.fn() },
        session: { sessionInfo: { id: 's1', data: {} } },
        signal: new AbortController().signal,
    }) as never

beforeEach(() => {
    vi.clearAllMocks()
})

describe('AuthController.resetPassword', () => {
    it.each([
        'invalid_token',
        'expired_token',
        'used_token',
        'token_required',
        'passwords_mismatch',
    ])('keeps the reason %s in the error body', async (reason) => {
        resetPassword.mockResolvedValue(Result.err(badRequest('Refused', reason)))
        const context = createContext({ token: 't', password: 'p', passwordConfirm: 'p' })

        const response = await AuthController.resetPassword(context)

        expect(response).toEqual({
            status: 'error',
            code: 'bad_request',
            message: 'Refused',
            reason,
        })
        expect((context as { responseData: { status: number } }).responseData.status).toBe(400)
    })

    it('answers success', async () => {
        resetPassword.mockResolvedValue(Result.ok({ status: 'success' }))

        const response = await AuthController.resetPassword(
            createContext({ token: 't', password: 'p', passwordConfirm: 'p' }),
        )

        expect(response).toEqual({ status: 'success' })
    })
})

describe('AuthController.startPhonePasswordReset', () => {
    it('answers only the generic message when no challenge was issued', async () => {
        startPhonePasswordReset.mockResolvedValue(Result.ok({ message: 'If the number exists…' }))

        const response = await AuthController.startPhonePasswordReset(
            createContext({ phone: '+380501234567' }),
        )

        expect(response).toEqual({ status: 'success', message: 'If the number exists…' })
    })

    it('passes the challenge fields through', async () => {
        const challenge = {
            message: 'If the number exists…',
            challengeId: 'ch-1',
            expiresAt: '2030-01-01T00:10:00.000Z',
            resendAvailableAt: '2030-01-01T00:01:00.000Z',
        }
        startPhonePasswordReset.mockResolvedValue(Result.ok(challenge))

        const response = await AuthController.startPhonePasswordReset(
            createContext({ phone: '+380501234567' }),
        )

        expect(response).toEqual({ status: 'success', ...challenge })
    })
})
