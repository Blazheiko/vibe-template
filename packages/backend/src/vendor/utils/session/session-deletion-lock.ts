import logger from '#vendor/utils/logger.js'
import { HttpError } from '#vendor/utils/network/errors/http-error.js'

/**
 * docs/plan/passkeys-mfa-plan.md (Р13): what the application does around the deletion of a signed-in
 * session's record by a logout or by a sign-in that replaces it. A role change or an MFA reset of
 * another account reads the record of the request's session under the actor's row lock and writes
 * under it; deleting the record under the same lock makes the deletion either come first (the
 * write answers 401 `session_revoked`) or wait until that write has committed. Registered at start
 * (app/start), so the session layer does not import the application's repositories; without it
 * (tests, the CLI) the record is deleted as before.
 */
export type SessionDeletionLock = (userId: string, work: () => Promise<boolean>) => Promise<boolean>
let sessionDeletionLock: SessionDeletionLock | null = null
export const registerSessionDeletionLock = (lock: SessionDeletionLock | null): void => {
    sessionDeletionLock = lock
}

/**
 * How many times, at most, the lock is asked for by one deletion: the first attempt and one
 * repeat, whether the repeat follows a cut wait (`busy`) or a lost connection
 * (`connection_lost`). One counter for both keeps the request within two lock waits (two
 * statement timeouts), as before connection losses were repeated.
 */
export const LOCK_WAIT_ATTEMPTS = 2

/**
 * Why taking the lock failed:
 * - `busy`: PostgreSQL answered, the wait was cut (57014 statement_timeout, 55P03 lock_timeout,
 *   40P01 a deadlock) or the pool had no free connection in time. A privileged write can still
 *   commit: the record is never deleted without the lock.
 * - `unreachable`: no connection to PostgreSQL could be opened (refused, an unknown or unreachable
 *   host, class 08, 57P03 the server starting). A privileged write commits through the same
 *   database, so it cannot commit either; the record is deleted without the lock, so a logout is
 *   not refused in an outage.
 * - `connection_lost`: the one connection of the attempt broke (a reset, a broken pipe, a socket
 *   timeout, `Connection terminated`, 57P01/57P02 the backend killed). That also happens to a
 *   single pooled connection (pg_terminate_backend, a pgbouncer restart, a dead idle socket)
 *   while the other connections of the pool still commit a privileged write, so it proves no
 *   outage: the lock is asked for again on a new connection (the pool discards the broken one),
 *   and that attempt decides.
 * - `other`: anything else (a query that got no answer in time, a bug). Not known to be safe: the
 *   record stays, as for `busy`, without another wait.
 */
export type LockFailure = 'busy' | 'unreachable' | 'connection_lost' | 'other'

const BUSY_SQLSTATES = new Set(['57014', '55P03', '40P01'])
/** cannot_connect_now; class 08 (connection exception) is checked by its prefix. */
const UNREACHABLE_SQLSTATES = new Set(['57P03'])
/** admin_shutdown (pg_terminate_backend too), crash_shutdown: this backend went away. */
const LOST_SQLSTATES = new Set(['57P01', '57P02'])
/** A connection could not be opened. */
const CONNECT_ERROR_CODES = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
])
/** An open connection broke. */
const LOST_ERROR_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT'])
const SQLSTATE = /^[0-9A-Z]{5}$/

const field = (value: unknown, key: string): unknown =>
    typeof value === 'object' && value !== null && key in value
        ? (value as Record<string, unknown>)[key]
        : undefined

const classifyOne = (value: unknown): LockFailure | null => {
    const code = field(value, 'code')
    // An ErrorResponse of PostgreSQL carries a severity; a Node errno code looks the same.
    if (
        typeof code === 'string' &&
        SQLSTATE.test(code) &&
        typeof field(value, 'severity') === 'string'
    ) {
        if (BUSY_SQLSTATES.has(code)) return 'busy'
        if (LOST_SQLSTATES.has(code)) return 'connection_lost'
        if (UNREACHABLE_SQLSTATES.has(code) || code.startsWith('08')) return 'unreachable'
        return 'other'
    }
    if (typeof code === 'string' && CONNECT_ERROR_CODES.has(code)) return 'unreachable'
    if (typeof code === 'string' && LOST_ERROR_CODES.has(code)) return 'connection_lost'
    const message = field(value, 'message')
    if (typeof message === 'string') {
        // pg: the connection broke (or its opening timed out): not known to be an outage.
        if (message.startsWith('Connection terminated')) return 'connection_lost'
        // pg-pool: no free connection within connectionTimeoutMillis (the pool is busy).
        if (message.includes('timeout exceeded when trying to connect')) return 'busy'
    }
    return null
}

/** Classifies a failure to take the lock; the driver error may be wrapped (Drizzle's `cause`). */
export const classifyLockFailure = (err: unknown): LockFailure => {
    let current: unknown = err
    for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
        const found = classifyOne(current)
        if (found !== null) return found
        current = field(current, 'cause')
    }
    return 'other'
}

/**
 * The record of a signed-in session could not be deleted under the lock (it is still held, or the
 * failure is not known to be an outage): nothing was deleted. The logout answers 503
 * `logout_retry` (auth-service); any other caller (a sign-in replacing the session) answers 503
 * with Retry-After and the client repeats the request.
 */
export class SessionDeletionDeferredError extends HttpError {
    readonly name = 'SessionDeletionDeferredError'
    readonly code = 'service_unavailable'
    readonly statusCode = 503

    constructor(options?: { cause?: unknown }) {
        super('Session record not deleted: the user row lock was not taken', options)
    }

    override get publicMessage(): string {
        return 'Service temporarily unavailable. Try again later.'
    }

    override headers(): Readonly<Record<string, string>> {
        return { 'Retry-After': '1' }
    }

    override logLevel(): 'warn' | 'error' {
        return 'warn'
    }

    override readonly logMessage = 'Request failed: session record not deleted under the lock'
}

/**
 * Deletes a record under the registered lock. A wait that is cut (`busy`) or a connection that
 * broke (`connection_lost`) is asked for again, within LOCK_WAIT_ATTEMPTS attempts in all; past
 * them, as for `other`, SessionDeletionDeferredError and the record stays. Only `unreachable`
 * (also on the repeat after a lost connection: then the database does not answer at all) deletes
 * without the lock. A failure of the deletion itself is the caller's, as without the lock; a
 * failure after it (the COMMIT of a transaction that wrote nothing) is not.
 */
export const deleteUnderLock = async (
    userId: unknown,
    work: () => Promise<boolean>,
): Promise<boolean> => {
    const lock = sessionDeletionLock
    if (lock === null || typeof userId !== 'string') return work()
    for (let attempt = 1; ; attempt++) {
        const progress: { stage: 'waiting' | 'deleting' | 'deleted'; removed: boolean } = {
            stage: 'waiting',
            removed: false,
        }
        try {
            return await lock(userId, async () => {
                progress.stage = 'deleting'
                progress.removed = await work()
                progress.stage = 'deleted'
                return progress.removed
            })
        } catch (err) {
            if (progress.stage === 'deleted') return progress.removed
            if (progress.stage === 'deleting') throw err
            const failure = classifyLockFailure(err)
            if (failure === 'unreachable') {
                logger.warn(
                    { err, attempt },
                    'PostgreSQL unreachable; the session record is deleted without the lock',
                )
                return work()
            }
            if (
                (failure === 'busy' || failure === 'connection_lost') &&
                attempt < LOCK_WAIT_ATTEMPTS
            ) {
                logger.warn(
                    { err, attempt, failure },
                    failure === 'busy'
                        ? 'User row lock wait cut; waiting again'
                        : 'User row lock connection lost; asking again on a new connection',
                )
                continue
            }
            logger.warn({ err, failure }, 'User row lock not taken; the session record stays')
            throw new SessionDeletionDeferredError({ cause: err })
        }
    }
}
