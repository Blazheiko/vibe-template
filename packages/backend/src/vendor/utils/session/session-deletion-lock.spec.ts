import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('#vendor/utils/logger.js', () => ({
    default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const {
    classifyLockFailure,
    deleteUnderLock,
    registerSessionDeletionLock,
    SessionDeletionDeferredError,
    LOCK_WAIT_ATTEMPTS,
} = await import('./session-deletion-lock.js')

// docs/plan/passkeys-mfa-plan.md (Р13): a session record is deleted without the user row lock only
// when PostgreSQL cannot be reached; a wait that was cut or a connection that broke is asked
// again, then the record stays.

/** An ErrorResponse of PostgreSQL as node-postgres raises it. */
const pgError = (code: string): Error =>
    Object.assign(new Error(`pg ${code}`), { code, severity: 'ERROR' })
/** As Drizzle wraps a failed query: the driver error is the `cause`. */
const wrapped = (cause: unknown): Error => new Error('Failed query: select ...', { cause })

describe('classifyLockFailure', () => {
    it.each([
        ['statement_timeout (57014)', pgError('57014')],
        ['lock_timeout (55P03)', pgError('55P03')],
        ['a deadlock (40P01)', pgError('40P01')],
        ['57014 wrapped by Drizzle', wrapped(pgError('57014'))],
        ['a busy pool', new Error('timeout exceeded when trying to connect')],
    ])('%s: busy', (_, err) => {
        expect(classifyLockFailure(err)).toBe('busy')
    })

    it.each([
        ['a refused connection', Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })],
        ['an unknown host', Object.assign(new Error('dns'), { code: 'ENOTFOUND' })],
        ['a failed DNS lookup', Object.assign(new Error('dns'), { code: 'EAI_AGAIN' })],
        ['an unreachable host', Object.assign(new Error('c'), { code: 'EHOSTUNREACH' })],
        ['an unreachable network', Object.assign(new Error('c'), { code: 'ENETUNREACH' })],
        ['the server starting (57P03)', pgError('57P03')],
        ['a connection exception (08006)', pgError('08006')],
        ['a connection refused by the server (08004)', pgError('08004')],
        [
            'ECONNREFUSED wrapped by Drizzle',
            wrapped(Object.assign(new Error('c'), { code: 'ECONNREFUSED' })),
        ],
    ])('%s: unreachable', (_, err) => {
        expect(classifyLockFailure(err)).toBe('unreachable')
    })

    it.each([
        ['a reset connection', Object.assign(new Error('read'), { code: 'ECONNRESET' })],
        ['a broken pipe', Object.assign(new Error('write'), { code: 'EPIPE' })],
        ['a socket timeout', Object.assign(new Error('read'), { code: 'ETIMEDOUT' })],
        ['a dropped connection', new Error('Connection terminated unexpectedly')],
        ['a connect timeout', new Error('Connection terminated due to connection timeout')],
        ['the backend terminated (57P01)', pgError('57P01')],
        ['the server crashed (57P02)', pgError('57P02')],
        ['57P01 wrapped by Drizzle', wrapped(pgError('57P01'))],
        [
            'ECONNRESET wrapped by Drizzle',
            wrapped(Object.assign(new Error('r'), { code: 'ECONNRESET' })),
        ],
    ])('%s: connection_lost', (_, err) => {
        expect(classifyLockFailure(err)).toBe('connection_lost')
    })

    it.each([
        ['another SQLSTATE', pgError('42P01')],
        [
            'an errno-looking code without a severity',
            Object.assign(new Error('x'), { code: 'EPERM' }),
        ],
        ['a five-letter code without a severity', Object.assign(new Error('x'), { code: '57014' })],
        ['a query without an answer in time', new Error('Query read timeout')],
        ['a plain error', new Error('boom')],
        ['not an error', 'boom'],
        ['nothing', undefined],
    ])('%s: other', (_, err) => {
        expect(classifyLockFailure(err)).toBe('other')
    })
})

describe('deleteUnderLock', () => {
    afterEach(() => {
        registerSessionDeletionLock(null)
    })

    it('without a lock, or for a session without a user, deletes at once', async () => {
        const work = vi.fn(() => Promise.resolve(true))
        expect(await deleteUnderLock('7', work)).toBe(true)
        registerSessionDeletionLock(() => Promise.reject(new Error('never')))
        expect(await deleteUnderLock(undefined, work)).toBe(true)
        expect(work).toHaveBeenCalledTimes(2)
    })

    it('a wait cut once is repeated and deletes under the lock', async () => {
        const lock = vi
            .fn()
            .mockRejectedValueOnce(wrapped(pgError('57014')))
            .mockImplementation((_: string, work: () => Promise<boolean>) => work())
        registerSessionDeletionLock(lock)
        const work = vi.fn(() => Promise.resolve(true))
        expect(await deleteUnderLock('7', work)).toBe(true)
        expect(lock).toHaveBeenCalledTimes(2)
        expect(work).toHaveBeenCalledTimes(1)
    })

    it('a wait cut every time: SessionDeletionDeferredError, nothing deleted', async () => {
        const lock = vi.fn(() => Promise.reject(pgError('55P03')))
        registerSessionDeletionLock(lock)
        const work = vi.fn(() => Promise.resolve(true))
        await expect(deleteUnderLock('7', work)).rejects.toBeInstanceOf(
            SessionDeletionDeferredError,
        )
        expect(lock).toHaveBeenCalledTimes(LOCK_WAIT_ATTEMPTS)
        expect(work).not.toHaveBeenCalled()
    })

    it('a failure not known to be an outage: deferred at once, nothing deleted', async () => {
        const lock = vi.fn(() => Promise.reject(new Error('Query read timeout')))
        registerSessionDeletionLock(lock)
        const work = vi.fn(() => Promise.resolve(true))
        await expect(deleteUnderLock('7', work)).rejects.toBeInstanceOf(
            SessionDeletionDeferredError,
        )
        expect(lock).toHaveBeenCalledTimes(1)
        expect(work).not.toHaveBeenCalled()
    })

    it('PostgreSQL unreachable: deleted without the lock', async () => {
        registerSessionDeletionLock(() =>
            Promise.reject(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })),
        )
        const work = vi.fn(() => Promise.resolve(true))
        expect(await deleteUnderLock('7', work)).toBe(true)
        expect(work).toHaveBeenCalledTimes(1)
    })

    describe('a lost connection is asked again on a new one', () => {
        const lost = () => pgError('57P01')
        const refused = () => Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })
        const underLock = (_: string, work: () => Promise<boolean>) => work()

        it('the repeat takes the lock: deleted under it', async () => {
            const lock = vi.fn().mockRejectedValueOnce(lost()).mockImplementation(underLock)
            registerSessionDeletionLock(lock)
            const work = vi.fn(() => Promise.resolve(true))
            expect(await deleteUnderLock('7', work)).toBe(true)
            expect(lock).toHaveBeenCalledTimes(2)
            expect(work).toHaveBeenCalledTimes(1)
        })

        it('the repeat cannot connect: unreachable, deleted without the lock', async () => {
            const lock = vi.fn().mockRejectedValueOnce(lost()).mockRejectedValueOnce(refused())
            registerSessionDeletionLock(lock)
            const work = vi.fn(() => Promise.resolve(true))
            expect(await deleteUnderLock('7', work)).toBe(true)
            expect(lock).toHaveBeenCalledTimes(2)
            expect(work).toHaveBeenCalledTimes(1)
        })

        it.each([
            ['lost again', lost()],
            ['a cut wait', pgError('57014')],
            ['a failure not known to be an outage', new Error('Query read timeout')],
        ])('the repeat fails with %s: deferred, nothing deleted', async (_, second) => {
            const lock = vi.fn().mockRejectedValueOnce(lost()).mockRejectedValueOnce(second)
            registerSessionDeletionLock(lock)
            const work = vi.fn(() => Promise.resolve(true))
            await expect(deleteUnderLock('7', work)).rejects.toBeInstanceOf(
                SessionDeletionDeferredError,
            )
            expect(lock).toHaveBeenCalledTimes(LOCK_WAIT_ATTEMPTS)
            expect(work).not.toHaveBeenCalled()
        })

        it('one bound for cut waits and lost connections together', async () => {
            const lock = vi
                .fn()
                .mockRejectedValueOnce(pgError('55P03'))
                .mockRejectedValueOnce(lost())
                .mockImplementation(underLock)
            registerSessionDeletionLock(lock)
            const work = vi.fn(() => Promise.resolve(true))
            await expect(deleteUnderLock('7', work)).rejects.toBeInstanceOf(
                SessionDeletionDeferredError,
            )
            expect(lock).toHaveBeenCalledTimes(LOCK_WAIT_ATTEMPTS)
            expect(work).not.toHaveBeenCalled()
        })
    })

    it('a failure of the deletion itself is the caller’s; one after it (COMMIT) is not', async () => {
        registerSessionDeletionLock(async (_userId, work) => {
            await work()
            throw new Error('connection lost at COMMIT')
        })
        expect(await deleteUnderLock('7', () => Promise.resolve(true))).toBe(true)

        registerSessionDeletionLock((_userId, work) => work())
        await expect(
            deleteUnderLock('7', () => Promise.reject(new Error('redis down'))),
        ).rejects.toThrow('redis down')
    })

    it('answers 503 with Retry-After', () => {
        const err = new SessionDeletionDeferredError()
        expect(err.statusCode).toBe(503)
        expect(err.code).toBe('service_unavailable')
        expect(err.headers()).toEqual({ 'Retry-After': '1' })
    })
})
