import { Result } from 'better-result'
import { uid } from '../../../../test-support/ids.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-233 (Р9): "end all other sessions" ends them before this session is renewed, so a failed
// renewal is a partial success, as after a password change: the client signs in again.

vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
})

const { revokeOthers, revoke, list, renewSession, closeUserConnections } = vi.hoisted(() => ({
    revokeOthers: vi.fn(),
    revoke: vi.fn(),
    list: vi.fn(),
    renewSession: vi.fn(),
    closeUserConnections: vi.fn(() => 0),
}))
vi.mock('#app/services/user/session-list-service.js', () => ({
    sessionListService: { revokeOthers, revoke, list },
}))
vi.mock('#app/services/auth/auth-service.js', () => ({ authService: { renewSession } }))
vi.mock('#app/services/auth/ws-session-revocation.js', () => ({
    wsSessionRevocation: { closeUserConnections },
}))

const { default: Controller } = await import('./account-sessions-controller.js')

const createContext = (params: Record<string, string> = {}) =>
    ({
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
        httpData: { params, query: {}, payload: {} },
        responseData: { status: 200 },
        auth: {
            check: () => true,
            getUserId: () => '7',
            getPresentedUserToken: () => 'presented-token',
        },
        session: {
            sessionInfo: { id: 's1', data: { userId: '7', userToken: 'presented-token' } },
            isStored: () => Promise.resolve(true),
        },
        signal: new AbortController().signal,
    }) as never

beforeEach(() => {
    vi.clearAllMocks()
    revokeOthers.mockResolvedValue(Result.ok({ sessionToken: 'rotated' }))
})

describe('AccountSessionsController.revokeOtherSessions', () => {
    it('renews this session under the rotated token and hands back its tokens', async () => {
        renewSession.mockResolvedValue(
            Result.ok({ csrfToken: 'c'.repeat(43), wsUrl: 'wss://x/ws', wsToken: 'ws-token' }),
        )
        const context = createContext()
        const response = await Controller.revokeOtherSessions(context)
        expect(revokeOthers).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: uid(7),
                presentedSessionToken: 'presented-token',
                requestingSessionId: 's1',
            }),
        )
        expect(renewSession).toHaveBeenCalledWith(
            (context as { auth: unknown }).auth,
            (context as { session: unknown }).session,
            'rotated',
        )
        expect(response).toEqual({
            status: 'success',
            sessionRenewed: true,
            csrfToken: 'c'.repeat(43),
            wsUrl: 'wss://x/ws',
            wsToken: 'ws-token',
        })
        expect(closeUserConnections).not.toHaveBeenCalled()
    })

    it.each([
        ['answers an error', () => renewSession.mockResolvedValue(Result.err(new Error('x')))],
        ['throws', () => renewSession.mockRejectedValue(new Error('redis down'))],
    ])(
        'a renewal that %s: success without renewal, this session’s sockets close',
        async (_, arrange) => {
            arrange()
            const response = await Controller.revokeOtherSessions(createContext())
            expect(response).toEqual({ status: 'success', sessionRenewed: false })
            expect(closeUserConnections).toHaveBeenCalledWith('7', { sessionId: 's1' })
        },
    )

    it('a refusal before the rotation is an ordinary error, nothing renewed', async () => {
        revokeOthers.mockResolvedValue(
            Result.err({ _tag: 'Unauthorized', message: 'revoked', reason: 'session_revoked' }),
        )
        const context = createContext()
        const response = await Controller.revokeOtherSessions(context)
        expect(response).toMatchObject({ status: 'error', reason: 'session_revoked' })
        expect(renewSession).not.toHaveBeenCalled()
    })
})

describe('AccountSessionsController.revokeSession', () => {
    it('an id that is not a public id is 404 without asking the service', async () => {
        const context = createContext({ id: 'not-a-public-id' })
        const response = await Controller.revokeSession(context)
        expect(response).toMatchObject({ status: 'error', code: 'not_found' })
        expect(revoke).not.toHaveBeenCalled()
    })
})
