import { Result } from 'better-result'
import type { SessionToken } from '#app/domain/secrets.js'
import { uid } from '../../../test-support/ids.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { testUserActor } from '../../../test-support/audit-actor.js'

// feat-233 (Р7–Р9): the session list service with its storage and repositories replaced. The
// Redis scripts and the HTTP routes are proved on real servers (session-index.redis.test.ts,
// account-sessions-http.pg.test.ts); this pins the decisions in between.

vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
})

const storage = vi.hoisted(() => ({
    listSessions: vi.fn(),
    findSessionByPublicId: vi.fn(),
    destroySession: vi.fn(),
    destroyAllSessions: vi.fn(),
}))
const repositories = vi.hoisted(() => ({
    updateIfSessionToken: vi.fn(),
    findSessionToken: vi.fn(),
    lockById: vi.fn(),
}))
const retirePendingResets = vi.hoisted(() => vi.fn())
const closeUserConnections = vi.hoisted(() => vi.fn())
const security = vi.hoisted(() => vi.fn())
const sessionListChanged = vi.hoisted(() => vi.fn())
const listUserConnections = vi.hoisted(() => vi.fn(() => [] as { sessionId: string }[]))
const TX = vi.hoisted(() => ({ tx: true }))

// feat-235: the audit write of each write point is covered by its *.pg.test.ts.
vi.mock('#app/services/audit/audit-service.js', () => ({
    auditService: {
        stamp: vi.fn(() => Promise.resolve({ occurredAt: '2026-11-20 00:00:00' })),
        record: vi.fn(() => Promise.resolve([])),
        logCommitted: vi.fn(),
    },
}))
vi.mock('#vendor/utils/session/redis-session-storage.js', () => storage)
vi.mock('#app/repositories/index.js', () => ({
    userRepository: repositories,
    withTransaction: <T>(work: (tx: unknown) => Promise<T>) => work(TX),
}))
vi.mock('#app/services/auth/phone-challenges.js', () => ({ retirePendingResets }))
vi.mock('#app/services/auth/ws-session-revocation.js', () => ({
    wsSessionRevocation: { closeUserConnections },
}))
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security },
}))
vi.mock('#vendor/utils/session/session-list-events.js', () => ({ sessionListChanged }))
vi.mock('#app/websocket/ws-connection-registry.js', () => ({
    wsConnectionRegistry: { listUserConnections },
}))
vi.mock('#vendor/utils/logger.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { sessionListService } = await import('./session-list-service.js')
const { encodeSessionCursor } = await import('#vendor/utils/session/session-page-cursor.js')

const device = (publicId: string, over: Record<string, unknown> = {}) => ({
    publicId,
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
    method: 'password' as const,
    signedInAt: '2026-11-19T10:00:00.000Z',
    ...over,
})
const CURRENT_ID = 'c'.repeat(22)
const current = {
    id: 'current-sid',
    data: { userId: '7', userToken: 'tok' as SessionToken, device: device(CURRENT_ID) },
    createdAt: '2026-11-19T10:00:00.000Z',
}
const stored = () => Promise.resolve(true)
const gone = () => Promise.resolve(false)

beforeEach(() => {
    vi.clearAllMocks()
    storage.listSessions.mockResolvedValue({ sessions: [], next: null })
    storage.findSessionByPublicId.mockResolvedValue({ sid: 'current-sid', seen: 1_763_500_000_000 })
    storage.destroySession.mockResolvedValue(true)
    storage.destroyAllSessions.mockResolvedValue({ deleted: 2, complete: true })
    listUserConnections.mockReturnValue([])
})

describe('list', () => {
    it('the first page carries the current session and excludes it from the others', async () => {
        listUserConnections.mockReturnValue([{ sessionId: 'other-sid' }])
        storage.listSessions.mockResolvedValue({
            sessions: [
                {
                    publicId: 'o'.repeat(22),
                    sessionId: 'other-sid',
                    createdAtMs: 1,
                    lastSeenAtMs: null,
                    info: { id: 'other-sid', data: { device: device('o'.repeat(22)) } },
                },
            ],
            next: { createdAtMs: 1, publicId: 'o'.repeat(22) },
        })
        const result = await sessionListService.list({ userId: '7', current, cursor: undefined })
        expect(storage.listSessions).toHaveBeenCalledWith('tok', {
            after: null,
            excludePublicId: CURRENT_ID,
        })
        if (!Result.isOk(result)) throw new Error('expected ok')
        expect(result.value.current).toMatchObject({
            id: CURRENT_ID,
            current: true,
            online: false,
            lastSeenAt: new Date(1_763_500_000_000).toISOString(),
        })
        expect(result.value.others).toEqual([
            expect.objectContaining({ id: 'o'.repeat(22), current: false, online: true }),
        ])
        expect(result.value.nextCursor).toBe(
            encodeSessionCursor({ createdAtMs: 1, publicId: 'o'.repeat(22) }),
        )
    })

    it('a later page has no current session; a cursor it never gave out is 400', async () => {
        const cursor = encodeSessionCursor({ createdAtMs: 5, publicId: 'x'.repeat(22) })
        const page = await sessionListService.list({ userId: '7', current, cursor })
        expect(Result.isOk(page) && page.value.current).toBe(null)
        expect(storage.listSessions).toHaveBeenCalledWith('tok', {
            after: { createdAtMs: 5, publicId: 'x'.repeat(22) },
            excludePublicId: CURRENT_ID,
        })

        const bad = await sessionListService.list({ userId: '7', current, cursor: 'nope' })
        expect(Result.isError(bad) && bad.error._tag).toBe('BadRequest')
    })
})

describe('revoke (Р8)', () => {
    const revoke = (publicId: string, sessionStored = stored) =>
        sessionListService.revoke({ userId: uid(7), current, publicId, sessionStored })

    it('ends the other session, closes its sockets, tells every device', async () => {
        storage.findSessionByPublicId.mockResolvedValue({ sid: 'other-sid', seen: null })
        const result = await revoke('o'.repeat(22))
        expect(Result.isOk(result)).toBe(true)
        expect(storage.destroySession).toHaveBeenCalledWith('other-sid', 'tok', 'o'.repeat(22))
        // Under the user's row lock (privileged-actor reads the record under the same lock).
        expect(repositories.lockById).toHaveBeenCalledWith(7n, TX)
        expect(repositories.lockById.mock.invocationCallOrder[0]).toBeLessThan(
            storage.destroySession.mock.invocationCallOrder[0] ?? 0,
        )
        expect(closeUserConnections).toHaveBeenCalledWith('7', { sessionId: 'other-sid' })
        expect(security).toHaveBeenCalledWith(7n, 'session_revoked')
        expect(sessionListChanged).toHaveBeenCalledWith('7')
    })

    it('the current session is 409 current_session, nothing ended', async () => {
        const result = await revoke(CURRENT_ID)
        expect(Result.isError(result) && result.error).toMatchObject({
            _tag: 'Conflict',
            reason: 'current_session',
        })
        expect(storage.destroySession).not.toHaveBeenCalled()
    })

    it('the asking session lost its record meanwhile: session_revoked, nothing ended', async () => {
        const result = await revoke('o'.repeat(22), gone)
        expect(Result.isError(result) && result.error).toMatchObject({
            _tag: 'Unauthorized',
            reason: 'session_revoked',
        })
        expect(storage.findSessionByPublicId).not.toHaveBeenCalled()
    })

    it.each([
        ['an unknown id', null, true],
        ['a session already gone', { sid: 'dead', seen: null }, false],
    ])('%s is 404', async (_, meta, removed) => {
        storage.findSessionByPublicId.mockResolvedValue(meta)
        storage.destroySession.mockResolvedValue(removed)
        const result = await revoke('o'.repeat(22))
        expect(Result.isError(result) && result.error._tag).toBe('NotFound')
        expect(closeUserConnections).not.toHaveBeenCalled()
        expect(security).not.toHaveBeenCalled()
    })
})

describe('revokeOthers (Р9)', () => {
    const revokeOthers = (sessionStored = stored, presented: string | null = 'tok') =>
        sessionListService.revokeOthers({
            actor: testUserActor(),
            userId: uid(7),
            presentedSessionToken: (presented ?? undefined) as SessionToken | undefined,
            requestingSessionId: 'current-sid',
            sessionStored,
        })

    it('rotates under the presented token, retires resets, spares this session’s sockets', async () => {
        repositories.updateIfSessionToken.mockResolvedValue({ id: 7n, phone: '+380501112233' })
        const result = await revokeOthers()
        if (!Result.isOk(result)) throw new Error('expected ok')
        const [userId, presented, change, tx] =
            repositories.updateIfSessionToken.mock.calls[0] ?? []
        expect([userId, presented, tx]).toEqual([7n, 'tok', TX])
        expect(change).toEqual({ sessionToken: result.value.sessionToken })
        expect(retirePendingResets).toHaveBeenCalledWith({ id: 7n, phone: '+380501112233' }, TX)
        expect(closeUserConnections).toHaveBeenCalledWith('7', { exceptSessionId: 'current-sid' })
        expect(storage.destroyAllSessions).toHaveBeenCalledWith('tok')
        expect(security).toHaveBeenCalledWith(7n, 'logout_all')
    })

    it('a cleanup that throws does not undo the revocation', async () => {
        repositories.updateIfSessionToken.mockResolvedValue({ id: 7n, phone: null })
        storage.destroyAllSessions.mockRejectedValue(new Error('redis down'))
        expect(Result.isOk(await revokeOthers())).toBe(true)
    })

    it('the asking session lost its record or presents no token: session_revoked, no rotation', async () => {
        for (const result of [await revokeOthers(gone), await revokeOthers(stored, null)]) {
            expect(Result.isError(result) && result.error).toMatchObject({
                reason: 'session_revoked',
            })
        }
        expect(repositories.updateIfSessionToken).not.toHaveBeenCalled()
    })

    it('the token was rotated meanwhile: session_revoked; the user is gone: 404', async () => {
        repositories.updateIfSessionToken.mockResolvedValue(undefined)
        repositories.findSessionToken.mockResolvedValue('newer')
        const lost = await revokeOthers()
        expect(Result.isError(lost) && lost.error).toMatchObject({ reason: 'session_revoked' })

        repositories.findSessionToken.mockResolvedValue(undefined)
        const missing = await revokeOthers()
        expect(Result.isError(missing) && missing.error._tag).toBe('NotFound')
        expect(retirePendingResets).not.toHaveBeenCalled()
        expect(closeUserConnections).not.toHaveBeenCalled()
    })
})
