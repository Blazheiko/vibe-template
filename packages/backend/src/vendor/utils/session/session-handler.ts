import type { HttpContext, Session, SessionData } from '#vendor/types/types.js'
import sessionConfig from '#config/session.js'
import {
    getSession,
    updateSessionData,
    changeSessionData,
    consumeSessionData,
    destroySession,
    sessionExists,
} from '#vendor/utils/session/redis-session-storage.js'
import logger from '#vendor/utils/logger.js'
import { RedisUnavailableError } from '#vendor/utils/network/errors/redis-unavailable-error.js'
import { assertSessionTokenCurrent } from '#vendor/utils/session/session-token-check.js'
import { maskTokenForLogs } from '#vendor/utils/helpers/mask-sensitive.js'
import { verifyAnonSessionToken, verifySignedToken } from '#vendor/utils/session/token-handler.js'
import { isValidCsrfToken } from '#vendor/utils/session/csrf-token.js'
import { RequestSession, type IncomingSession } from '#vendor/utils/session/request-session.js'

const isValidUserToken = (token: unknown): token is string =>
    typeof token === 'string' && /^[a-zA-Z0-9_-]{10,}$/.test(token)

logger.info(`Session storage: ${sessionConfig.storage}`)

/**
 * Reads the session cookie: a fresh anonymous cookie, a verified signed cookie of a stored
 * session, or nothing (no cookie, an expired anonymous one, a forged or malformed one).
 */
const readIncomingSession = (
    context: HttpContext,
    accessToken: string | undefined,
): IncomingSession => {
    if (accessToken === undefined) return { kind: 'none' }

    const anonClaims = verifyAnonSessionToken(accessToken)
    if (anonClaims !== null) {
        const age = Math.floor(Date.now() / 1000) - anonClaims.issuedAt
        const fresh =
            age >= 0 && age < sessionConfig.anonAge && isValidCsrfToken(anonClaims.csrfToken)
        return fresh ? { kind: 'anonymous-cookie', ...anonClaims } : { kind: 'none' }
    }

    const clientMeta = {
        ip: context.httpData.ip,
        userAgent: context.httpData.headers.get('user-agent'),
    }
    const verified = verifySignedToken(accessToken)
    if (verified === null) {
        logger.warn(clientMeta, 'Invalid access token')
        return { kind: 'none' }
    }
    if (!isValidUserToken(verified.cookieUserToken)) {
        logger.warn(clientMeta, 'Invalid cookieUserToken format in token')
        return { kind: 'none' }
    }
    return { kind: 'stored', sessionId: verified.sessionId, userToken: verified.cookieUserToken }
}

/** Gives the request its session (see RequestSession) through context.session / context.auth. */
export const sessionHandler = async (
    context: HttpContext,
    accessToken: string | undefined,
    _userId: string | undefined,
): Promise<void> => {
    const session = await RequestSession.restore(context, readIncomingSession(context, accessToken))
    session.attach()
}

export type WsSessionResult =
    { kind: 'ok'; session: Session } | { kind: 'missing' } | { kind: 'unavailable' }

const MISSING: WsSessionResult = { kind: 'missing' }

export const wsSessionHandler = async (
    sessionId: string,
    userToken: string,
): Promise<WsSessionResult> => {
    try {
        if (!isValidUserToken(userToken)) {
            logger.warn({ sessionId }, 'wsSessionHandler: invalid userToken format')
            return MISSING
        }

        const sessionInfo = await getSession(sessionId, userToken)

        if (sessionInfo === null) {
            logger.warn({ sessionId, userToken: maskTokenForLogs(userToken) }, 'Session not found')
            return MISSING
        }

        if (typeof sessionInfo.data.userId !== 'string' || sessionInfo.data.userId === '') {
            logger.warn(
                { sessionId, userToken: maskTokenForLogs(userToken) },
                'wsSessionHandler: session has no userId — not authenticated',
            )
            return MISSING
        }

        const tokenStatus = await assertSessionTokenCurrent(sessionInfo, userToken)
        if (tokenStatus === 'unavailable') return { kind: 'unavailable' }
        if (tokenStatus === 'mismatch') {
            logger.warn(
                { sessionId, userToken: maskTokenForLogs(userToken) },
                'wsSessionHandler: session revoked (sessionToken rotated)',
            )
            return MISSING
        }

        const session: Session = {
            sessionInfo,
            updateSessionData: async (newData: SessionData) =>
                await updateSessionData(sessionInfo.id, newData, userToken),
            changeSessionData: async (newData: SessionData) =>
                await changeSessionData(sessionInfo.id, newData, userToken),
            isStored: async () => await sessionExists(sessionInfo.id, userToken),
            consumeSessionData: async (expected, keys) =>
                (await consumeSessionData(sessionInfo.id, userToken, expected, keys)).kind,
            destroySession: async (): Promise<void> => {
                await destroySession(sessionInfo.id, userToken)
            },
        }
        return { kind: 'ok', session }
    } catch (err) {
        // Not an expired session: the caller keeps the connection open.
        if (err instanceof RedisUnavailableError) return { kind: 'unavailable' }
        logger.error(
            { err, sessionId, userToken: maskTokenForLogs(userToken) },
            'wsSessionHandler error',
        )
        return MISSING
    }
}
