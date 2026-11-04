import crypto from 'node:crypto'

import type {
    DestroyAllSessionsResult,
    HttpContext,
    SessionData,
    SessionInfo,
} from '#vendor/types/types.js'
import sessionConfig from '#config/session.js'
import {
    anonSessionSignedIn,
    anonSessionSuperseded,
    changeSessionData,
    claimCookieRefresh,
    destroyAllSessions,
    destroySession,
    getSession,
    markAnonSessionSuperseded,
    markCookieIssued,
    saveSession,
    sessionExists,
    updateSessionData,
} from '#vendor/utils/session/redis-session-storage.js'
import logger from '#vendor/utils/logger.js'
import { SessionVerificationUnavailableError } from '#vendor/utils/network/errors/session-verification-unavailable-error.js'
import { assertSessionTokenCurrent } from '#vendor/utils/session/session-token-check.js'
import { ANON_SESSION_NAMESPACE, storedSessionTtl } from '#vendor/utils/session/session-ttl.js'
import { maskTokenForLogs } from '#vendor/utils/helpers/mask-sensitive.js'
import { createAnonSessionToken, createSignedToken } from '#vendor/utils/session/token-handler.js'
import { generateCsrfToken, isValidCsrfToken } from '#vendor/utils/session/csrf-token.js'

/** Storage namespace of a session without a user. */
const ANON_TOKEN = ANON_SESSION_NAMESPACE

/**
 * How often the cookie of an unchanged stored session is sent again to slide its expiry.
 * Re-sending it on every request let a slow response restore a session cookie that a
 * concurrent request (password change, logout-all) had already replaced.
 */
const COOKIE_REFRESH_SECONDS = 60 * 60

/** A cookie-held anonymous session is re-issued once it is older than this (sliding TTL). */
const ANON_COOKIE_REFRESH_SECONDS = 15 * 60

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

const withCsrfToken = (data: SessionData): SessionData => ({
    ...data,
    csrfToken: isValidCsrfToken(data.csrfToken) ? data.csrfToken : generateCsrfToken(),
})

const newAnonSessionInfo = (): SessionInfo => ({
    id: crypto.randomUUID(),
    data: withCsrfToken({}),
    createdAt: new Date().toISOString(),
})

/** A new stored session for a signed-in user. */
const createSessionInfo = async (data: SessionData): Promise<SessionInfo> => {
    const session: SessionInfo = {
        id: crypto.randomUUID(),
        data: withCsrfToken(data),
        createdAt: new Date().toISOString(),
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

const MAX_CLOCK_SKEW_MS = 5 * 60_000
const DAY_MS = 24 * 60 * 60_000

/**
 * feat-111: a stored session lives at most SESSION_MAX_AGE_DAYS from its createdAt, however often
 * it is used (the TTL slides with every request). A createdAt that does not parse, or lies in the
 * future beyond the clock skew, cannot prove the age and ends the session too.
 */
export const isPastMaxAge = (createdAt: unknown, now = Date.now()): boolean => {
    if (typeof createdAt !== 'string') return true
    const created = Date.parse(createdAt)
    if (Number.isNaN(created)) return true
    if (created - now > MAX_CLOCK_SKEW_MS) return true
    return now - created >= sessionConfig.maxAgeDays * DAY_MS
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

/** What the session cookie of the request said, already verified by the caller. */
export type IncomingSession =
    /** A valid cookie-held anonymous session (feat-057): nothing is stored for it. */
    | { kind: 'anonymous-cookie'; sessionId: string; csrfToken: string; issuedAt: number }
    /** A signed cookie of a session stored in Redis. */
    | { kind: 'stored'; sessionId: string; userToken: string }
    /** No cookie, or one that did not verify. */
    | { kind: 'none' }

/**
 * What has to be confirmed right before the response goes out, so that a slow response
 * does not restore a cookie another request has replaced meanwhile. One per request.
 */
type PreSendCheck =
    /** A stored session re-sends its cookie: dropped if the session was deleted meanwhile. */
    | { kind: 'stored-cookie-refresh'; sessionId: string; userToken: string }
    /** A cookie-held anonymous session is re-issued: dropped if it was signed in meanwhile. */
    | { kind: 'anonymous-cookie-refresh'; sessionId: string }
    /**
     * This request moved its anonymous session to Redis. Its own record is no sign of a
     * change, but a login of the same session made meanwhile is: dropped then.
     */
    | { kind: 'anonymous-promotion'; sessionId: string }

/**
 * The session of one HTTP request: its state and every way it can change. Exposed to
 * handlers through `context.session` and `context.auth` (`attach`).
 *
 * States: an anonymous session held only in its signed cookie (`cookieHeld`), an
 * anonymous session stored in Redis, or a signed-in session stored in Redis. Changes:
 * storing data in a cookie-held session moves it to Redis; `login` replaces any session
 * with a new signed-in one; `logout` / `logoutAll` replace it with a new cookie-held one
 * (`logoutAll` also when its cleanup of the other records fails).
 */
export class RequestSession {
    private info: SessionInfo
    /** The session lives only in its signed cookie (anonymous, nothing stored yet). */
    private cookieHeld: boolean
    /** Storage namespace of the current session: the user token, or ANON_TOKEN. */
    private storageToken: string
    /** login / logout replaced the session in this request: its own Set-Cookie is current. */
    private swapped = false
    private preSendCheck: PreSendCheck | null = null
    /**
     * The user token of the signed-in session the request presented and `restore` verified
     * as current. Set once and never changed: login, logout and renewal in this request
     * replace `info` and `storageToken`, not this.
     */
    private readonly presentedUserToken: string | undefined

    private constructor(
        private readonly context: HttpContext,
        info: SessionInfo,
        state: { cookieHeld: boolean; storageToken: string; presentedUserToken?: string },
    ) {
        this.info = info
        this.cookieHeld = state.cookieHeld
        this.storageToken = state.storageToken
        this.presentedUserToken = state.presentedUserToken
    }

    /**
     * Turns the request's session cookie into the session it names, or a new anonymous one,
     * and re-sends the cookie where its expiry has to slide.
     */
    static async restore(context: HttpContext, incoming: IncomingSession): Promise<RequestSession> {
        let info: SessionInfo | null = null
        let cookieHeld = false
        let presentedId: string | undefined
        let presentedUserToken: string | undefined
        let anonymousRefreshDue = false

        if (incoming.kind === 'anonymous-cookie') {
            info = {
                id: incoming.sessionId,
                data: { csrfToken: incoming.csrfToken },
                createdAt: new Date(incoming.issuedAt * 1000).toISOString(),
            }
            cookieHeld = true
            anonymousRefreshDue = nowSeconds() - incoming.issuedAt > ANON_COOKIE_REFRESH_SECONDS
        } else if (incoming.kind === 'stored') {
            presentedId = incoming.sessionId
            presentedUserToken = incoming.userToken
            info = await getSession(incoming.sessionId, incoming.userToken)
            if (info !== null && isPastMaxAge(info.createdAt)) {
                // Too old: ended like a revoked one, without asking the database.
                await dropRevokedSession(incoming.sessionId, incoming.userToken)
                info = null
            }
            if (info === null) {
                // The record expired or was deleted: the cookie names nothing. The new
                // anonymous session must not inherit its user token as storage namespace.
                presentedId = undefined
                presentedUserToken = undefined
            } else {
                // ADR 0002: the Redis record only proves the session was issued. A rotated
                // users.sessionToken revokes it, whether or not the cleanup reached Redis.
                const status = await assertSessionTokenCurrent(info, incoming.userToken)
                if (status === 'unavailable') {
                    // Fail-closed: not served on the strength of the Redis record alone.
                    throw new SessionVerificationUnavailableError()
                }
                if (status === 'mismatch') {
                    await dropRevokedSession(incoming.sessionId, incoming.userToken)
                    info = null
                    presentedId = undefined
                    presentedUserToken = undefined
                }
            }
        }

        // A stored session without a valid CSRF token gets one. feat-111: the update never
        // recreates a record; when it is gone (a logout in another tab got there first) the
        // loaded info is dropped and the request goes on as a new anonymous session.
        if (info !== null && !cookieHeld && !isValidCsrfToken(info.data.csrfToken)) {
            const repairToken =
                presentedUserToken ??
                (typeof info.data.userToken === 'string' ? info.data.userToken : undefined)
            const updated = await updateSessionData(
                info.id,
                { csrfToken: generateCsrfToken() },
                repairToken ?? ANON_TOKEN,
            )
            info = updated
            if (updated === null) {
                presentedId = undefined
                presentedUserToken = undefined
            }
        }

        const startsNew = info === null
        if (info === null) {
            info = newAnonSessionInfo()
            cookieHeld = true
        }

        const userToken =
            presentedUserToken ??
            (typeof info.data.userToken === 'string' ? info.data.userToken : undefined)

        // Only a signed-in session presents a user token worth comparing with
        // users.session_token; an anonymous one presents none.
        const signedInToken =
            presentedUserToken !== undefined && typeof info.data.userId === 'string'
                ? presentedUserToken
                : undefined
        const session = new RequestSession(context, info, {
            cookieHeld,
            storageToken: userToken ?? ANON_TOKEN,
            ...(signedInToken !== undefined ? { presentedUserToken: signedInToken } : {}),
        })

        if (startsNew) {
            session.issueAnonymousCookie()
        } else if (anonymousRefreshDue) {
            session.issueAnonymousCookie()
            session.schedule({ kind: 'anonymous-cookie-refresh', sessionId: info.id })
        }

        // The refresh claims a separate marker (SET NX EX) and never rewrites the session:
        // a read-then-write here could restore a session another request just deleted.
        // A cookie-held session was re-issued above and has no Redis record to check.
        const presented = info.id === presentedId
        if (
            !cookieHeld &&
            (!presented || (await claimCookieRefresh(info.id, COOKIE_REFRESH_SECONDS)))
        ) {
            if (presented) {
                session.schedule({
                    kind: 'stored-cookie-refresh',
                    sessionId: info.id,
                    userToken: userToken ?? ANON_TOKEN,
                })
            }
            // Same lifetime as the record: a stored anonymous session presents the
            // anon_session namespace as its user token, not undefined.
            session.issueStoredCookie(info.id, userToken, storedSessionTtl(userToken ?? ANON_TOKEN))
        }

        return session
    }

    /** Exposes the session to the handlers through `context.session` and `context.auth`. */
    attach(): void {
        const { session, auth } = this.context
        session.sessionInfo = this.info
        session.updateSessionData = this.updateData.bind(this)
        session.changeSessionData = this.changeData.bind(this)
        session.destroySession = this.destroy.bind(this)
        auth.getUserId = this.userId.bind(this)
        auth.getPresentedUserToken = this.getPresentedUserToken.bind(this)
        auth.check = this.isSignedIn.bind(this)
        auth.login = this.login.bind(this)
        auth.logout = this.logout.bind(this)
        auth.logoutAll = this.logoutAll.bind(this)
    }

    // --- session data ------------------------------------------------------------------

    /** Merges into the session data. A cookie-held session moves to Redis first. */
    private async updateData(newData: SessionData): Promise<SessionInfo | null> {
        return this.cookieHeld
            ? await this.storeAnonymous({ ...this.info.data, ...newData })
            : await updateSessionData(this.info.id, newData, this.storageToken)
    }

    /** Replaces the session data. A cookie-held session moves to Redis first. */
    private async changeData(newData: SessionData): Promise<SessionInfo | null> {
        return this.cookieHeld
            ? await this.storeAnonymous(newData)
            : await changeSessionData(this.info.id, newData, this.storageToken)
    }

    private async destroy(): Promise<void> {
        await destroySession(this.info.id, this.storageToken)
    }

    private isSignedIn(): boolean {
        return Boolean(this.info.data.userId)
    }

    private getPresentedUserToken(): string | undefined {
        return this.presentedUserToken
    }

    private userId(): string | null {
        const userId = this.info.data.userId
        return typeof userId === 'string' ? userId : null
    }

    /**
     * Storing data in a cookie-held session moves it to Redis (anonymous TTL) and switches
     * its cookie to the stored-session form.
     */
    private async storeAnonymous(data: SessionData): Promise<SessionInfo> {
        const stored: SessionInfo = { ...this.info, data, updatedAt: new Date().toISOString() }
        await saveSession(stored)
        this.issueStoredCookie(stored.id, undefined, sessionConfig.anonAge)
        this.cookieHeld = false
        // saveSession stores a session without a user under the anonymous namespace; later
        // changes in this request must address the same record.
        this.storageToken = ANON_TOKEN
        // The move answers for its own cookie now; a pending refresh check is moot.
        this.schedule({ kind: 'anonymous-promotion', sessionId: stored.id })
        this.setInfo(stored)
        return stored
    }

    // --- sign-in state -----------------------------------------------------------------

    /** Replaces the current session, whatever it was, with a new signed-in one. */
    private async login(
        userId: string | undefined,
        userToken: string | undefined,
    ): Promise<boolean> {
        if (userId === undefined || userToken === undefined) return false

        // The previous session goes away whether it was signed in or anonymous: its cookie
        // and CSRF token must not stay usable after the login.
        const previousId = this.info.id
        // Any anonymous predecessor — cookie-held or already moved to Redis — is marked
        // before it goes away: a slower response of that session must not re-issue its
        // anonymous cookie over the login's one.
        if (this.cookieHeld || this.storageToken === ANON_TOKEN) {
            await markAnonSessionSuperseded(previousId, ANON_COOKIE_REFRESH_SECONDS)
        }
        // A cookie-held session may still have a record: a parallel request can have moved
        // it to Redis.
        await destroySession(previousId, this.storageToken)

        const signedIn = await createSessionInfo({ userId, userToken })
        this.issueStoredCookie(signedIn.id, userToken, sessionConfig.age)
        this.setInfo(signedIn)
        this.storageToken = userToken
        this.cookieHeld = false
        this.swapped = true

        logger.info({ userId, sessionId: signedIn.id }, `User logged in`)
        return true
    }

    /** Deletes the current signed-in session and starts a new anonymous one. */
    private async logout(): Promise<boolean> {
        const userToken = this.signedInUserToken()
        if (userToken !== undefined) {
            await destroySession(this.info.id, userToken)
            logger.info(
                { userId: this.info.data.userId, sessionId: this.info.id },
                `User logged out`,
            )
        }

        this.becomeAnonymous()
        return true
    }

    /**
     * Deletes every session record of the user, then starts a new anonymous session. The
     * caller rotates users.session_token first (ADR 0002): that is the revocation, this is
     * memory cleanup, and the anonymous session is issued even when the cleanup stops or
     * throws. Returns what the cleanup reports (`deleted: 0, complete: true` for a guest).
     */
    private async logoutAll(): Promise<DestroyAllSessionsResult> {
        const userToken = this.signedInUserToken()
        if (userToken === undefined) return { deleted: 0, complete: true }

        try {
            const result = await destroyAllSessions(userToken)
            logger.info(
                { userId: this.info.data.userId, ...result },
                `User logged out all sessions`,
            )
            return result
        } finally {
            this.becomeAnonymous()
        }
    }

    private signedInUserToken(): string | undefined {
        const userToken = this.info.data.userToken
        return typeof userToken === 'string' ? userToken : undefined
    }

    private becomeAnonymous(): void {
        this.setInfo(newAnonSessionInfo())
        this.issueAnonymousCookie()
        this.storageToken = ANON_TOKEN
        this.cookieHeld = true
        this.swapped = true
    }

    private setInfo(info: SessionInfo): void {
        this.info = info
        this.context.session.sessionInfo = info
    }

    // --- cookies -----------------------------------------------------------------------

    private setCookie(value: string, maxAge: number): void {
        this.context.responseData.setCookie(sessionConfig.cookieName, value, {
            path: sessionConfig.cookie.path,
            httpOnly: sessionConfig.cookie.httpOnly,
            secure: sessionConfig.cookie.secure,
            maxAge,
            sameSite: sessionConfig.cookie.sameSite,
            expires: new Date(Date.now() + maxAge * 1000),
        })
    }

    /** The signed cookie of a stored session: `<userToken | anon_session>.<sessionId>`. */
    private issueStoredCookie(
        sessionId: string,
        userToken: string | undefined,
        maxAge: number,
    ): void {
        this.setCookie(createSignedToken(`${userToken ?? ANON_TOKEN}.${sessionId}`), maxAge)
    }

    // feat-057: an anonymous session is kept in its signed cookie, not in Redis, so a
    // request without a cookie (a bot hitting main/init) writes nothing.
    private issueAnonymousCookie(): void {
        const csrfToken = this.info.data.csrfToken
        if (!isValidCsrfToken(csrfToken)) throw new Error('Anonymous session without a CSRF token')
        const token = createAnonSessionToken({
            sessionId: this.info.id,
            csrfToken,
            issuedAt: nowSeconds(),
        })
        this.setCookie(token, sessionConfig.anonAge)
    }

    // --- before the response goes out ---------------------------------------------------

    private schedule(check: PreSendCheck): void {
        this.preSendCheck = check
        this.context.session.beforeSend = this.discardStaleCookie.bind(this)
    }

    /**
     * Run by the server right before the response goes out (`session.beforeSend`). A request
     * that re-sends a cookie must not restore it if another request replaced the session
     * meanwhile. Requests that swapped the session themselves (login, logout) keep their
     * cookie. Runs its check once; a failed check holds the cookie back.
     */
    private async discardStaleCookie(): Promise<void> {
        const check = this.preSendCheck
        if (check === null) return
        this.preSendCheck = null

        switch (check.kind) {
            case 'anonymous-promotion':
                if (this.swapped) return
                await this.holdBackCookieIf(
                    (): Promise<boolean> => anonSessionSignedIn(check.sessionId),
                    'Stored anonymous cookie held back: session check failed',
                )
                return
            case 'anonymous-cookie-refresh':
                if (this.swapped) return
                await this.holdBackCookieIf(
                    (): Promise<boolean> => anonSessionSuperseded(check.sessionId),
                    'Anonymous cookie refresh skipped: session check failed',
                )
                return
            case 'stored-cookie-refresh':
                if (this.info.id !== check.sessionId) return
                // The handler's result stands; only the unconfirmed cookie is held back.
                await this.holdBackCookieIf(
                    async (): Promise<boolean> =>
                        !(await sessionExists(check.sessionId, check.userToken)),
                    'Session cookie refresh skipped: session check failed',
                )
                return
        }
    }

    private async holdBackCookieIf(
        isStale: () => Promise<boolean>,
        failureMessage: string,
    ): Promise<void> {
        try {
            if (await isStale()) this.context.responseData.cookies.delete(sessionConfig.cookieName)
        } catch (err) {
            logger.warn({ err }, failureMessage)
            this.context.responseData.cookies.delete(sessionConfig.cookieName)
        }
    }
}
