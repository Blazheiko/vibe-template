import { Result } from 'better-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Partial success of POST /auth/change-password: the password is written to
// PostgreSQL before the session is renewed in Redis, so a Redis failure after the
// write must not be reported as a failed password change.

const { changePassword, renewSession } = vi.hoisted(() => ({
    changePassword: vi.fn(),
    renewSession: vi.fn(),
}))

vi.mock('#app/services/auth/auth-service.js', () => ({
    authService: { changePassword, renewSession },
}))
vi.mock('#app/services/auth/email-verification-service.js', () => ({
    emailVerificationService: {},
}))
vi.mock('#app/services/auth/password-reset-service.js', () => ({
    passwordResetService: {},
    GENERIC_RESET_MESSAGE: '',
}))

const { default: AuthController } = await import('./auth-controller.js')

const createContext = () => {
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
    return {
        logger,
        httpData: { payload: { currentPassword: 'old-password', newPassword: 'new-password' } },
        responseData: { status: 200 },
        auth: { check: () => true, getUserId: () => '7' },
        session: { sessionInfo: { id: 's1', data: { userId: '7' } } },
        signal: new AbortController().signal,
    } as never as Parameters<typeof AuthController.changePassword>[0] & {
        logger: typeof logger
    }
}

describe('AuthController.changePassword', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        changePassword.mockResolvedValue(Result.ok({ status: 'success' }))
    })

    it('returns the renewed session tokens', async () => {
        renewSession.mockResolvedValue(
            Result.ok({ csrfToken: 'c'.repeat(43), wsUrl: 'wss://x/ws', wsToken: 'ws-token' }),
        )

        const response = await AuthController.changePassword(createContext())

        expect(response).toEqual({
            status: 'success',
            sessionRenewed: true,
            csrfToken: 'c'.repeat(43),
            wsUrl: 'wss://x/ws',
            wsToken: 'ws-token',
        })
    })

    it('still reports the changed password when Redis fails after the write', async () => {
        renewSession.mockResolvedValue(Result.err({ kind: 'unavailable', message: 'Redis down' }))
        const context = createContext()

        const response = await AuthController.changePassword(context)

        expect(changePassword).toHaveBeenCalledOnce()
        expect(response).toEqual({ status: 'success', sessionRenewed: false })
        expect(context.responseData.status).toBe(200)
        expect(context.logger.error).toHaveBeenCalledWith(
            expect.anything(),
            'Session renewal after password change failed',
        )
    })

    it('does not renew the session when the password change fails', async () => {
        changePassword.mockResolvedValue(Result.err({ kind: 'bad_request', message: 'Wrong' }))

        await AuthController.changePassword(createContext())

        expect(renewSession).not.toHaveBeenCalled()
    })
})
