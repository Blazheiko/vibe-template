import crypto from 'node:crypto'

import type { HttpContext, Session, SessionData, SessionInfo } from '#vendor/types/types.js'
import sessionConfig from '#config/session.js'
import {
    saveSession,
    getSession,
    updateSessionData,
    changeSessionData,
    destroySession,
    destroyAllSessions,
    claimCookieRefresh,
    markCookieIssued,
    sessionExists,
    markAnonSessionSuperseded,
    anonSessionSuperseded,
    anonSessionSignedIn,
} from '#vendor/utils/session/redis-session-storage.js'
import logger from '#vendor/utils/logger.js'
import { RedisUnavailableError } from '#vendor/utils/network/errors/redis-unavailable-error.js'
import { SessionVerificationUnavailableError } from '#vendor/utils/network/errors/session-verification-unavailable-error.js'
import { assertSessionTokenCurrent } from '#vendor/utils/session/session-token-check.js'
import { maskTokenForLogs } from '#vendor/utils/helpers/mask-sensitive.js'
import {
    createAnonSessionToken,
    createSignedToken,
    verifyAnonSessionToken,
    verifySignedToken,
} from '#vendor/utils/session/token-handler.js'
import type { ResponseData } from '#vendor/types/types.js'
import { generateCsrfToken, isValidCsrfToken } from '#vendor/utils/session/csrf-token.js'

const isValidUserToken = (token: unknown): token is string =>
    typeof token === 'string' && /^[a-zA-Z0-9_-]{10,}$/.test(token)

logger.info(`Session storage: ${sessionConfig.storage}`)

const generateSessionId = (): string => crypto.randomUUID()

const withCsrfToken = (data: SessionData): SessionData => ({
    ...data,
    csrfToken: isValidCsrfToken(data.csrfToken) ? data.csrfToken : generateCsrfToken(),
})

/**
 * How often the cookie of an unchanged session is sent again to slide its expiry.
 * Re-sending it on every request let a slow response restore a session cookie
 * that a concurrent request (password change, logout-all) had already replaced.
 */
const COOKIE_REFRESH_SECONDS = 60 * 60

// Requests that re-send the cookie of the session they arrived with; checked again
// before the response goes out (discardStaleSessionCookie).
const pendingCookieRefresh = new WeakMap<HttpContext, { sessionId: string; userToken: string }>()
// Requests that re-issue a cookie-held anonymous session (id), checked the same way.
const pendingAnonRefresh = new WeakMap<HttpContext, string>()
// Requests that moved their anonymous session to Redis (id). Their own record is no
// sign of a change, but a login made meanwhile is: its cookie must not be undone.
const pendingAnonPromotion = new WeakMap<HttpContext, string>()
// Requests that replaced their session themselves (login, logout): their own
// Set-Cookie is the current one and is never held back.
const swappedSession = new WeakSet<HttpContext>()

const createSessionInfo = async (data: SessionData = {}): Promise<SessionInfo> => {
    const session: SessionInfo = {
        id: generateSessionId(),
        data: withCsrfToken(data),
        createdAt: new Date().toISOString(),
        // expiresAt: DateTime.now().plus({ seconds: sessionConfig.age }).toISO(),
    }

    await saveSession(session)
    // Its cookie goes out with this response: no refresh for the next hour. The
    // session already exists, so a failed marker only means an earlier refresh.
    try {
        await markCookieIssued(session.id, COOKIE_REFRESH_SECONDS)
    } catch (err) {
        logger.warn({ err }, 'Cookie refresh marker not set for a new session')
    }

    return session
}

const ANON_TOKEN = 'anon_session'

/** A cookie-held anonymous session is re-issued once it is older than this (sliding TTL). */
const ANON_COOKIE_REFRESH_SECONDS = 15 * 60

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

const setSessionCookie = (responseData: ResponseData, value: string, maxAge: number): void => {
    responseData.setCookie(sessionConfig.cookieName, value, {
        path: sessionConfig.cookie.path,
        httpOnly: sessionConfig.cookie.httpOnly,
        secure: sessionConfig.cookie.secure,
        maxAge,
        sameSite: sessionConfig.cookie.sameSite,
        expires: new Date(Date.now() + maxAge * 1000),
    })
}

// feat-057: an anonymous session is kept in its signed cookie, not in Redis, so a
// request without a cookie (a bot hitting main/init) writes nothing.
const issueAnonCookie = (responseData: ResponseData, sessionInfo: SessionInfo): void => {
    const csrfToken = sessionInfo.data.csrfToken
    if (!isValidCsrfToken(csrfToken)) throw new Error('Anonymous session without a CSRF token')
    const token = createAnonSessionToken({
        sessionId: sessionInfo.id,
        csrfToken,
        issuedAt: nowSeconds(),
    })
    setSessionCookie(responseData, token, sessionConfig.anonAge)
}

const newAnonSessionInfo = (): SessionInfo => ({
    id: generateSessionId(),
    data: withCsrfToken({}),
    createdAt: new Date().toISOString(),
})

const createCookieValue = (sessionId: string, userToken: string | undefined): string =>
    userToken !== undefined ? `${userToken}.${sessionId}` : `${ANON_TOKEN}.${sessionId}`

const updateContextWithNewSession = (
    context: HttpContext,
    newSessionInfo: SessionInfo,
    userToken: string | undefined,
    responseData: ResponseData,
): SessionInfo => {
    const cookieValue = createCookieValue(newSessionInfo.id, userToken)
    setSessionCookie(responseData, createSignedToken(cookieValue), sessionConfig.age)

    context.session.sessionInfo = newSessionInfo

    return newSessionInfo
}

// Memory cleanup only: the revocation itself is the rotated sessionToken, so a Redis
// failure here is logged, not raised.
const dropRevokedSession = async (sessionId: string, userToken: string): Promise<void> => {
    try {
        await destroySession(sessionId, userToken)
    } catch (err) {
        logger.warn(
            { err, sessionId, userToken: maskTokenForLogs(userToken) },
            'Could not delete a revoked session record',
        )
    }
}

export const sessionHandler = async (
    context: HttpContext,
    accessToken: string | undefined,
    _userId: string | undefined,
    // The cookie arrived under the legacy name: re-issue it under the current one.
    forceCookie = false,
): Promise<void> => {
    const { responseData } = context

    let sessionId: string | undefined
    let cookieUserToken: string | undefined

    const anonClaims = accessToken !== undefined ? verifyAnonSessionToken(accessToken) : null
    const anonAge = anonClaims !== null ? nowSeconds() - anonClaims.issuedAt : 0
    const cookieAnon =
        anonClaims !== null &&
        anonAge >= 0 &&
        anonAge < sessionConfig.anonAge &&
        isValidCsrfToken(anonClaims.csrfToken)
            ? anonClaims
            : null

    if (accessToken !== undefined && anonClaims === null) {
        const verifiedData = verifySignedToken(accessToken)

        if (verifiedData !== null) {
            ;({ cookieUserToken, sessionId } = verifiedData)

            if (!isValidUserToken(cookieUserToken)) {
                logger.warn(
                    {
                        ip: context.httpData.ip,
                        userAgent: context.httpData.headers.get('user-agent'),
                    },
                    'Invalid cookieUserToken format in token',
                )
                cookieUserToken = undefined
                sessionId = undefined
            }
        } else {
            logger.warn(
                {
                    ip: context.httpData.ip,
                    userAgent: context.httpData.headers.get('user-agent'),
                },
                'Invalid access token',
            )
        }
    }

    let sessionInfo: SessionInfo | null = null
    // The session lives only in its cookie (anonymous, nothing stored yet).
    let cookieHeld = false

    if (cookieAnon !== null) {
        sessionInfo = {
            id: cookieAnon.sessionId,
            data: { csrfToken: cookieAnon.csrfToken },
            createdAt: new Date(cookieAnon.issuedAt * 1000).toISOString(),
        }
        cookieHeld = true
        // forceCookie: the cookie came under the legacy name, which session_web deletes.
        if (anonAge > ANON_COOKIE_REFRESH_SECONDS || forceCookie) {
            issueAnonCookie(responseData, sessionInfo)
            pendingAnonRefresh.set(context, sessionInfo.id)
            context.session.beforeSend = async (): Promise<void> => {
                await discardStaleSessionCookie(context)
            }
        }
    } else if (sessionId !== undefined && cookieUserToken !== undefined) {
        sessionInfo = await getSession(sessionId, cookieUserToken)
        if (sessionInfo !== null) {
            // ADR 0002: the Redis record only proves the session was issued. A rotated
            // users.sessionToken revokes it, whether or not the cleanup reached Redis.
            const status = await assertSessionTokenCurrent(sessionInfo, cookieUserToken)
            if (status === 'unavailable') {
                // Fail-closed: not served on the strength of the Redis record alone.
                throw new SessionVerificationUnavailableError()
            }
            if (status === 'mismatch') {
                await dropRevokedSession(sessionId, cookieUserToken)
                sessionInfo = null
                sessionId = undefined
                cookieUserToken = undefined
            }
        }
    }

    if (sessionInfo === null) {
        sessionInfo = newAnonSessionInfo()
        cookieHeld = true
        issueAnonCookie(responseData, sessionInfo)
    }

    const sessionUserToken =
        cookieUserToken ??
        (typeof sessionInfo.data.userToken === 'string' ? sessionInfo.data.userToken : undefined)
    if (!cookieHeld && !isValidCsrfToken(sessionInfo.data.csrfToken)) {
        const updatedSessionInfo = await updateSessionData(
            sessionInfo.id,
            {
                csrfToken: generateCsrfToken(),
            },
            sessionUserToken ?? ANON_TOKEN,
        )
        if (updatedSessionInfo !== null) {
            sessionInfo = updatedSessionInfo
        }
    }
    const presented = sessionInfo.id === sessionId
    // The refresh claims a separate marker (SET NX EX) and never rewrites the session:
    // a read-then-write here could restore a session another request just deleted.
    // A cookie-held session was re-issued above and has no Redis record to check.
    if (
        !cookieHeld &&
        (!presented ||
            forceCookie ||
            (await claimCookieRefresh(sessionInfo.id, COOKIE_REFRESH_SECONDS)))
    ) {
        if (presented) {
            pendingCookieRefresh.set(context, {
                sessionId: sessionInfo.id,
                userToken: sessionUserToken ?? ANON_TOKEN,
            })
            context.session.beforeSend = async (): Promise<void> => {
                await discardStaleSessionCookie(context)
            }
        }
        const cookieValue = createCookieValue(sessionInfo.id, sessionUserToken)
        setSessionCookie(
            responseData,
            createSignedToken(cookieValue),
            sessionUserToken === undefined ? sessionConfig.anonAge : sessionConfig.age,
        )
    }

    // Storage namespace of the current session. Reassigned when login/logout swap the
    // session, so session helpers called later in the same request address the new one.
    let contextUserToken = sessionUserToken ?? ANON_TOKEN

    // Storing data in a cookie-held session moves it to Redis (anonymous TTL) and
    // switches its cookie to the stored-session form.
    const storeAnonSession = async (data: SessionData): Promise<SessionInfo | null> => {
        if (sessionInfo === null) return null
        const stored: SessionInfo = { ...sessionInfo, data, updatedAt: new Date().toISOString() }
        await saveSession(stored)
        setSessionCookie(
            responseData,
            createSignedToken(createCookieValue(stored.id, undefined)),
            sessionConfig.anonAge,
        )
        cookieHeld = false
        // The move answers for its own cookie now; a pending refresh check is moot.
        pendingAnonRefresh.delete(context)
        pendingAnonPromotion.set(context, stored.id)
        context.session.beforeSend = async (): Promise<void> => {
            await discardStaleSessionCookie(context)
        }
        sessionInfo = stored
        context.session.sessionInfo = stored
        return stored
    }

    context.session.sessionInfo = sessionInfo
    context.session.updateSessionData = async (
        newData: SessionData,
    ): Promise<SessionInfo | null> =>
        cookieHeld
            ? await storeAnonSession({ ...sessionInfo?.data, ...newData })
            : await updateSessionData(sessionInfo?.id, newData, contextUserToken)
    context.session.changeSessionData = async (
        newData: SessionData,
    ): Promise<SessionInfo | null> =>
        cookieHeld
            ? await storeAnonSession(newData)
            : await changeSessionData(sessionInfo?.id, newData, contextUserToken)
    context.session.destroySession = async (): Promise<void> => {
        await destroySession(sessionInfo?.id, contextUserToken)
    }

    context.auth.getUserId = (): string | null => {
        if (sessionInfo === null) return null
        if (sessionInfo.data.userId === undefined) return null
        return typeof sessionInfo.data.userId === 'string' ? sessionInfo.data.userId : null
    }
    context.auth.check = (): boolean => Boolean(sessionInfo?.data.userId)
    context.auth.login = async (
        userId: string | undefined,
        userToken: string | undefined,
    ): Promise<boolean> => {
        if (userId === undefined || userToken === undefined) return false
        try {
            // The previous session goes away whether it was signed in or anonymous:
            // its cookie and CSRF token must not stay usable after the login.
            const oldSessionId = sessionInfo?.id
            if (oldSessionId !== undefined) {
                // Any anonymous predecessor — cookie-held or already moved to Redis — is
                // marked before it goes away: a slower response of that session must
                // not re-issue its anonymous cookie over the login's one.
                if (cookieHeld || contextUserToken === ANON_TOKEN) {
                    await markAnonSessionSuperseded(oldSessionId, ANON_COOKIE_REFRESH_SECONDS)
                }
                // A cookie-held session may still have a record: a parallel request
                // can have moved it to Redis.
                await destroySession(oldSessionId, contextUserToken)
            }

            const newSessionInfo = await createSessionInfo({
                userId,
                userToken,
            })

            sessionInfo = updateContextWithNewSession(
                context,
                newSessionInfo,
                userToken,
                responseData,
            )
            contextUserToken = userToken
            cookieHeld = false
            swappedSession.add(context)

            logger.info({ userId, sessionId: newSessionInfo.id }, `User logged in`)

            return true
        } catch (err) {
            logger.error({ err }, 'Login error:')
            throw err
        }
    }

    context.auth.logout = async (): Promise<boolean> => {
        try {
            const currentUserToken =
                typeof sessionInfo?.data.userToken === 'string'
                    ? sessionInfo.data.userToken
                    : undefined
            const currentSessionId = sessionInfo?.id
            if (currentUserToken !== undefined && currentSessionId !== undefined) {
                await destroySession(currentSessionId, currentUserToken)
                logger.info(
                    {
                        userId: sessionInfo?.data.userId,
                        sessionId: currentSessionId,
                    },
                    `User logged out`,
                )
            }

            sessionInfo = newAnonSessionInfo()
            issueAnonCookie(responseData, sessionInfo)
            context.session.sessionInfo = sessionInfo
            contextUserToken = ANON_TOKEN
            cookieHeld = true
            swappedSession.add(context)

            return true
        } catch (err) {
            logger.error({ err }, 'Logout error')
            throw err
        }
    }

    context.auth.logoutAll = async (): Promise<number> => {
        try {
            const currentUserToken =
                typeof sessionInfo?.data.userToken === 'string'
                    ? sessionInfo.data.userToken
                    : undefined
            if (currentUserToken === undefined) return 0

            // The current session survives a stopped run, so the client can repeat
            // logoutAll while still authenticated; it is deleted last.
            const deletedCount = await destroyAllSessions(currentUserToken, sessionInfo?.id)
            logger.info(
                {
                    userId: sessionInfo?.data.userId,
                    deletedCount,
                },
                `User logged out all sessions`,
            )

            sessionInfo = newAnonSessionInfo()
            issueAnonCookie(responseData, sessionInfo)
            context.session.sessionInfo = sessionInfo
            contextUserToken = ANON_TOKEN
            cookieHeld = true
            swappedSession.add(context)

            return deletedCount
        } catch (err) {
            logger.error({ err }, 'LogoutAll error')
            throw err
        }
    }
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
            destroySession: async (): Promise<void> => {
                await destroySession(sessionInfo.id, userToken)
            },
            destroyAllSessions: async (): Promise<number> => {
                return await destroyAllSessions(userToken)
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

// export default { sessionHandler, wsSessionHandler };

/**
 * Before the response goes out: a request that re-sends the cookie of the session
 * it arrived with must not restore that cookie if the session was deleted meanwhile
 * (a password change or logout-all in another request replaced it). Requests that
 * swapped the session themselves (login, logout) keep their cookie.
 */
export const discardStaleSessionCookie = async (context: HttpContext): Promise<void> => {
    const promotedId = pendingAnonPromotion.get(context)
    if (promotedId !== undefined) {
        pendingAnonPromotion.delete(context)
        if (swappedSession.has(context)) return
        try {
            if (await anonSessionSignedIn(promotedId)) {
                context.responseData.cookies.delete(sessionConfig.cookieName)
            }
        } catch (err) {
            logger.warn({ err }, 'Stored anonymous cookie held back: session check failed')
            context.responseData.cookies.delete(sessionConfig.cookieName)
        }
        return
    }
    const anonId = pendingAnonRefresh.get(context)
    if (anonId !== undefined) {
        pendingAnonRefresh.delete(context)
        if (swappedSession.has(context)) return
        try {
            if (await anonSessionSuperseded(anonId)) {
                context.responseData.cookies.delete(sessionConfig.cookieName)
            }
        } catch (err) {
            logger.warn({ err }, 'Anonymous cookie refresh skipped: session check failed')
            context.responseData.cookies.delete(sessionConfig.cookieName)
        }
        return
    }
    const pending = pendingCookieRefresh.get(context)
    if (pending === undefined) return
    pendingCookieRefresh.delete(context)
    if (context.session.sessionInfo?.id !== pending.sessionId) return
    try {
        if (!(await sessionExists(pending.sessionId, pending.userToken))) {
            context.responseData.cookies.delete(sessionConfig.cookieName)
        }
    } catch (err) {
        // The handler's result stands; only the unconfirmed cookie is held back.
        logger.warn({ err }, 'Session cookie refresh skipped: session check failed')
        context.responseData.cookies.delete(sessionConfig.cookieName)
    }
}
