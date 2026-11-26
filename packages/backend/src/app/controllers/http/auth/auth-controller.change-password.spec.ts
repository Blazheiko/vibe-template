import { Result } from 'better-result'
import { uid } from '../../../../test-support/ids.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Partial success of POST /auth/change-password: the password is written to
// PostgreSQL before the session is renewed in Redis, so a Redis failure after the
// write must not be reported as a failed password change.

const { changePassword, renewSession, closeUserConnections } = vi.hoisted(() => ({
    changePassword: vi.fn(),
    renewSession: vi.fn(),
    closeUserConnections: vi.fn(() => 0),
}))

// feat-235: the audit write of each write point is covered by its *.pg.test.ts.
vi.mock('#app/services/audit/audit-service.js', () => ({
    auditService: {
        stamp: vi.fn(() => Promise.resolve({ occurredAt: '2026-11-20 00:00:00' })),
        record: vi.fn(() => Promise.resolve([])),
        logCommitted: vi.fn(),
    },
}))
vi.mock('#app/services/auth/ws-session-revocation.js', () => ({
    wsSessionRevocation: { closeUserConnections },
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

// feat-245: the session's auth state the step-up of POST /auth/reauth left.
const sessionAuth = {
    v: 1,
    amr: ['pwd'],
    aal: 1,
    authenticatedAt: '2026-11-20T00:00:00.000Z',
    verified: { pwd: '2026-11-20T00:00:00.000Z' },
}

const createContext = () => {
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
    return {
        logger,
        httpData: { payload: { newPassword: 'new-password' } },
        responseData: { status: 200 },
        auth: {
            check: () => true,
            getUserId: () => '7',
            getPresentedUserToken: () => 'presented-token',
        },
        session: { sessionInfo: { id: 's1', data: { userId: '7', auth: sessionAuth } } },
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

    // feat-091 (ADR 0004): the renewal now throws on a storage failure instead of returning
    // an error; a done password change must still not become a 500.
    it('still reports the changed password when the renewal throws', async () => {
        const redisError = new Error('Command timed out')
        renewSession.mockRejectedValue(redisError)
        const context = createContext()

        const response = await AuthController.changePassword(context)

        expect(response).toEqual({ status: 'success', sessionRenewed: false })
        expect(context.responseData.status).toBe(200)
        expect(context.logger.error).toHaveBeenCalledWith(
            { err: redisError },
            'Session renewal after password change failed',
        )
    })

    it('does not renew the session when the password change fails', async () => {
        changePassword.mockResolvedValue(Result.err({ kind: 'bad_request', message: 'Wrong' }))

        await AuthController.changePassword(createContext())

        expect(renewSession).not.toHaveBeenCalled()
    })

    // feat-096: the service compares the token the request presented with users.session_token.
    // feat-245: and decides by the session's auth state whether the change is allowed.
    it('hands the service the presented session token and the session auth state', async () => {
        renewSession.mockResolvedValue(
            Result.ok({ csrfToken: 'c'.repeat(43), wsUrl: 'wss://x/ws', wsToken: 'ws-token' }),
        )

        await AuthController.changePassword(createContext())

        expect(changePassword).toHaveBeenCalledWith(
            7n,
            { newPassword: 'new-password' },
            'presented-token',
            expect.any(Function),
            's1',
            // feat-235: the signed-in user of the request is the actor of the audit event.
            expect.objectContaining({ kind: 'user', userId: uid(7) }),
            sessionAuth,
        )
    })

    // feat-221: the service spares this session's sockets for the renewal. A 4001 sent before
    // the answer made the client ask for a WS token with the old cookie, get 401, sign out.
    it('leaves the sockets of the renewed session to its client', async () => {
        renewSession.mockResolvedValue(
            Result.ok({ csrfToken: 'c'.repeat(43), wsUrl: 'wss://x/ws', wsToken: 'ws-token' }),
        )

        await AuthController.changePassword(createContext())

        expect(closeUserConnections).not.toHaveBeenCalled()
    })

    it('closes the sockets of the session when it could not be renewed', async () => {
        renewSession.mockRejectedValue(new Error('Command timed out'))

        const response = await AuthController.changePassword(createContext())

        expect(response).toEqual({ status: 'success', sessionRenewed: false })
        expect(closeUserConnections).toHaveBeenCalledWith('7', { sessionId: 's1' })
    })

    it('closes nothing itself when the password change fails', async () => {
        changePassword.mockResolvedValue(Result.err({ kind: 'bad_request', message: 'Wrong' }))

        await AuthController.changePassword(createContext())

        expect(closeUserConnections).not.toHaveBeenCalled()
    })

    it('answers 401 session_revoked without renewing when the session was revoked', async () => {
        const { sessionRevoked } = await import('#app/services/shared/errors.js')
        changePassword.mockResolvedValue(Result.err(sessionRevoked()))
        const context = createContext()

        const response = await AuthController.changePassword(context)

        expect(context.responseData.status).toBe(401)
        expect(response).toMatchObject({ code: 'unauthorized', reason: 'session_revoked' })
        expect(renewSession).not.toHaveBeenCalled()
    })
})
