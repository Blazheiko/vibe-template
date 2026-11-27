import crypto from 'node:crypto'

import type {
    ActivationHooks,
    DestroyAllSessionsResult,
    HttpContext,
    LoginOrigin,
    LoginPlan,
    SessionData,
    SessionDevice,
    SessionInfo,
} from '#vendor/types/types.js'
import {
    isValidEntityId,
    nowUnixMs,
    seconds,
    unixSecondsOf,
    type Seconds,
    type UnixSeconds,
} from 'shared/brand'
import { USER_AGENT_MAX_LENGTH } from 'shared/utils'
import sessionConfig from '#config/session.js'
import {
    anonSessionSignedIn,
    anonSessionSuperseded,
    changeSessionData,
    claimCookieRefresh,
    createSignedInSession,
    destroyAllSessions,
    destroySession,
    getSession,
    markAnonSessionSuperseded,
    markCookieIssued,
    releaseCookieRefresh,
    saveSession,
    sessionExists,
    touchSession,
    updateSessionData,
    updateSessionAuth,
    consumeSessionData,
    sanitizeRedisKey,
} from '#vendor/utils/session/redis-session-storage.js'
import { isActiveRecovery, type SessionAuthState } from 'shared/mfa'
import logger from '#vendor/utils/logger.js'
import { SessionVerificationUnavailableError } from '#vendor/utils/network/errors/session-verification-unavailable-error.js'
import { assertSessionTokenCurrent } from '#vendor/utils/session/session-token-check.js'
import { ANON_SESSION_NAMESPACE, storedSessionTtl } from '#vendor/utils/session/session-ttl.js'
import { maskTokenForLogs } from '#vendor/utils/helpers/mask-sensitive.js'
import { createAnonSessionToken, createSignedToken } from '#vendor/utils/session/token-handler.js'
import { generateCsrfToken, isValidCsrfToken } from '#vendor/utils/session/csrf-token.js'
import { sessionPublicId } from '#vendor/utils/session/session-public-id.js'
import { sessionListChanged } from '#vendor/utils/session/session-list-events.js'
import { deleteUnderLock } from '#vendor/utils/session/session-deletion-lock.js'
import {
    activatePendingSession,
    claimActivationEffects,
    preparePendingSession,
} from '#vendor/utils/session/session-index.js'

/** Storage namespace of a session without a user. */
const ANON_TOKEN = ANON_SESSION_NAMESPACE

/**
 * How often the cookie of an unchanged stored session is sent again to slide its expiry.
 * Re-sending it on every request let a slow response restore a session cookie that a
 * concurrent request (password change, logout-all) had already replaced.
 */
const COOKIE_REFRESH_SECONDS = seconds(60 * 60)

/** A cookie-held anonymous session is re-issued once it is older than this (sliding TTL). */
const ANON_COOKIE_REFRESH_SECONDS = seconds(15 * 60)

const nowSeconds = (): UnixSeconds => unixSecondsOf(nowUnixMs())

const withCsrfToken = (data: SessionData): SessionData => ({
    ...data,
    csrfToken: isValidCsrfToken(data.csrfToken) ? data.csrfToken : generateCsrfToken(),
})

/**
 * feat-245 (Р2): the auth state of a sign-in that did not pass one: level 1 by the origin's
 * method, proven now. A renewal without a state keeps none (a session stored before feat-245).
 */
const defaultSignInAuth = (origin: LoginOrigin, now: Date): SessionAuthState | undefined => {
    if ('inherit' in origin) return undefined
    const method =
        origin.method === 'oauth' ? 'oauth' : origin.method === 'passkey' ? 'webauthn' : 'pwd'
    const at = now.toISOString()
    return {
        v: 1,
        amr: [method],
        aal: method === 'webauthn' ? 2 : 1,
        authenticatedAt: at,
        verified: { [method]: at },
    }
}

/** feat-245 (Р4): `__Host-mfa` where the session cookie has the prefix, `mfa` elsewhere. */
export const mfaTicketCookieName = (): string =>
    sessionConfig.useHostPrefix ? '__Host-mfa' : 'mfa'

/**
 * feat-257 (docs/plan/mfa-review-fixes-7-plan.md, item 2): the cookie the ticket is bound to, a
 * random value of its own for each ticket, set and cleared with the ticket cookie. It outlives a
 * replaced or deleted session, so a sign-in confirmed before a lost answer can still be finished.
 */
export const mfaBindCookieName = (): string =>
    sessionConfig.useHostPrefix ? '__Host-mfa_bind' : 'mfa_bind'

/**
 * feat-245 (Р4): what the application does when a request comes with the session a second-step
 * sign-in created and with the ticket cookie (the browser got the answer): it retires the ticket.
 * Registered at start (app/start), so this module does not import the application.
 */
type SignInCompletionHook = (context: HttpContext, completionId: string) => Promise<void>
let signInCompletionHook: SignInCompletionHook | null = null
export const registerSignInCompletionHook = (hook: SignInCompletionHook): void => {
    signInCompletionHook = hook
}
/** Run by session_web once the session is attached (context.auth works then). */
export const runSignInCompletionHook = async (context: HttpContext): Promise<void> => {
    const completionId = context.session.sessionInfo?.data.completionId
    if (signInCompletionHook === null || typeof completionId !== 'string') return
    if (context.httpData.cookies.get(mfaTicketCookieName()) === undefined) return
    try {
        await signInCompletionHook(context, completionId)
    } catch (err) {
        logger.warn({ err }, 'Second-step ticket not retired; it expires by itself')
    }
}

const newAnonSessionInfo = (): SessionInfo => ({
    id: crypto.randomUUID(),
    data: withCsrfToken({}),
    createdAt: new Date().toISOString(),
})

/**
 * A new stored session for a signed-in user, with its device (feat-233): written together with
 * its index member and meta field.
 */
const createSessionInfo = async (
    data: SessionData & { userToken: string },
    device: Omit<SessionDevice, 'publicId'>,
): Promise<SessionInfo> => {
    const id = crypto.randomUUID()
    const publicId = sessionPublicId(id)
    const now = Date.now()
    const session: SessionInfo = {
        id,
        data: withCsrfToken({ ...data, device: { ...device, publicId } }),
        createdAt: new Date(now).toISOString(),
    }

    await createSignedInSession(session, data.userToken, publicId, now)
    // Its cookie goes out with this response: no refresh for the next hour. The
    // session already exists, so a failed marker only means an earlier refresh.
    try {
        await markCookieIssued(session.id, COOKIE_REFRESH_SECONDS)
    } catch (err) {
        logger.warn({ err }, 'Cookie refresh marker not set for a new session')
    }

    return session
}

const touchSeen = async (sessionId: string, userToken: string): Promise<void> => {
    try {
        await touchSession(sessionId, userToken)
    } catch (err) {
        logger.warn({ err, sessionId }, 'lastSeenAt of a session not written')
        try {
            await releaseCookieRefresh(sessionId)
        } catch (releaseErr) {
            logger.warn({ err: releaseErr, sessionId }, 'Cookie refresh marker not released')
        }
    }
}

const clientUserAgent = (context: HttpContext): string =>
    (context.httpData.headers.get('user-agent') ?? '').slice(0, USER_AGENT_MAX_LENGTH)

// The age check lives with the session store (feat-119); re-exported for existing importers.
export { isPastMaxAge } from '#vendor/utils/session/session-age.js'

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
    /** Whether the warning about a stored user id that is not a row id was written. */
    private invalidUserIdLogged = false
    /**
     * The user token of the signed-in session the request presented and `restore` verified
     * as current. Set once and never changed: login, logout and renewal in this request
     * replace `info` and `storageToken`, not this.
     */
    private readonly presentedUserToken: string | undefined
    /**
     * feat-245 (Р4): the session id the request's cookie named, verified by its signature, whatever
     * became of that session (an anonymous one replaced by a sign-in whose answer was lost).
     */

    private constructor(
        private readonly context: HttpContext,
        info: SessionInfo,
        state: {
            cookieHeld: boolean
            storageToken: string
            presentedUserToken?: string
        },
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
            // A record past SESSION_MAX_AGE_DAYS comes back null and is deleted by the store
            // (feat-119: the same check for HTTP and WebSocket).
            info = await getSession(incoming.sessionId, incoming.userToken)
            // feat-245 (Р4): a pending record is a sign-in not confirmed yet: it opens nothing.
            if (info !== null && info.data.pending === true) info = null
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
                } else if (
                    info.data.auth?.recovery !== undefined &&
                    !isActiveRecovery(info.data.auth, Date.now())
                ) {
                    // feat-245 (Р8): a recovery session ends at its absolute expiry, whatever the
                    // record's TTL says; the request goes on as a new anonymous session.
                    await destroySession(incoming.sessionId, incoming.userToken)
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
                // feat-233 (Р4): lastSeenAt rides on the hourly refresh, so a request writes no
                // more than it did. A failed write gives the marker back for the next request.
                if (signedInToken !== undefined) await touchSeen(info.id, signedInToken)
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
        session.consumeSessionData = this.consumeData.bind(this)
        session.updateSessionAuth = this.updateAuth.bind(this)
        session.isStored = this.isStored.bind(this)
        session.destroySession = this.destroy.bind(this)
        auth.getUserId = this.userId.bind(this)
        auth.getPresentedUserToken = this.getPresentedUserToken.bind(this)
        auth.check = this.isSignedIn.bind(this)
        auth.login = this.login.bind(this)
        auth.logout = this.logout.bind(this)
        auth.logoutAll = this.logoutAll.bind(this)
        auth.planLogin = this.planLogin.bind(this)
        auth.getMfaTicketCookie = (): string | undefined =>
            this.context.httpData.cookies.get(mfaTicketCookieName()) ?? undefined
        auth.getMfaBindCookie = (): string | undefined =>
            this.context.httpData.cookies.get(mfaBindCookieName()) ?? undefined
        auth.setMfaTicketCookie = this.setMfaTicketCookie.bind(this)
        auth.prepareLogin = this.prepareLogin.bind(this)
        auth.activateLogin = this.activateLogin.bind(this)
    }

    // --- session data ------------------------------------------------------------------

    /** Merges into the session data. A cookie-held session moves to Redis first. */
    private async updateData(newData: SessionData): Promise<SessionInfo | null> {
        return this.cookieHeld
            ? await this.storeAnonymous({ ...this.info.data, ...newData })
            : await updateSessionData(this.info.id, newData, this.storageToken)
    }

    /**
     * feat-245 (Р2): a signed-in session's auth state; a cookie-held (anonymous) session has none
     * to change.
     */
    private async updateAuth(
        apply: (current: SessionAuthState) => SessionAuthState,
        options?: { removeKeys?: readonly string[] },
    ): Promise<SessionInfo | null> {
        if (this.cookieHeld) return null
        const updated = await updateSessionAuth(
            this.info.id,
            this.storageToken,
            apply,
            options?.removeKeys,
        )
        if (updated !== null) this.setInfo(updated)
        return updated
    }

    /** Replaces the session data. A cookie-held session moves to Redis first. */
    private async changeData(newData: SessionData): Promise<SessionInfo | null> {
        return this.cookieHeld
            ? await this.storeAnonymous(newData)
            : await changeSessionData(this.info.id, newData, this.storageToken)
    }

    /**
     * feat-119: removes single-use values only while they are still the expected ones. A
     * cookie-held session has nothing stored to consume.
     */
    private async consumeData(
        expected: Record<string, string>,
        keys: readonly string[],
    ): Promise<'consumed' | 'mismatch' | 'gone'> {
        if (this.cookieHeld) return 'mismatch'
        const result = await consumeSessionData(this.info.id, this.storageToken, expected, keys)
        if (result.kind === 'consumed') this.setInfo(result.session)
        return result.kind
    }

    /** feat-123: whether this session's record still exists; a cookie-held one has none. */
    private async isStored(): Promise<boolean> {
        if (this.cookieHeld) return false
        return sessionExists(this.info.id, this.storageToken)
    }

    private async destroy(): Promise<void> {
        await destroySession(this.info.id, this.storageToken)
    }

    private isSignedIn(): boolean {
        return this.userId() !== null
    }

    private getPresentedUserToken(): string | undefined {
        return this.presentedUserToken
    }

    /**
     * The id of the signed-in user, or null. A stored id that is not the canonical id of a row
     * (feat-263, ADR 0007 Р13) is no user: the app brands it as a UserId from here, and a record
     * that holds anything else is answered like an anonymous session (and logged once).
     */
    private userId(): string | null {
        const userId = this.info.data.userId
        if (typeof userId !== 'string' || userId === '') return null
        if (isValidEntityId(userId)) return userId
        if (!this.invalidUserIdLogged) {
            this.invalidUserIdLogged = true
            logger.warn('session holds a user id that is not a row id; treated as signed out')
        }
        return null
    }

    /**
     * Storing data in a cookie-held session moves it to Redis (anonymous TTL) and switches
     * its cookie to the stored-session form.
     */
    private async storeAnonymous(data: SessionData): Promise<SessionInfo> {
        const stored: SessionInfo = { ...this.info, data, updatedAt: new Date().toISOString() }
        await saveSession(stored)
        this.issueStoredCookie(stored.id, undefined, sessionConfig.anonAgeSeconds)
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

    /**
     * Replaces the current session, whatever it was, with a new signed-in one, and answers its
     * device (feat-233). A renewal (`inherit`) keeps how and where the user signed in.
     */
    private async login(
        userId: string | undefined,
        userToken: string | undefined,
        origin: LoginOrigin,
        auth?: SessionAuthState,
    ): Promise<SessionDevice | null> {
        if (userId === undefined || userToken === undefined) return null

        // The previous session goes away whether it was signed in or anonymous: its cookie
        // and CSRF token must not stay usable after the login.
        await this.destroyReplaced()

        const authState = auth ?? defaultSignInAuth(origin, new Date())
        const signedIn = await createSessionInfo(
            { userId, userToken, ...(authState !== undefined ? { auth: authState } : {}) },
            this.deviceFor(origin),
        )
        this.issueStoredCookie(signedIn.id, userToken, sessionConfig.ageSeconds)
        this.setInfo(signedIn)
        this.storageToken = userToken
        this.cookieHeld = false
        this.swapped = true

        logger.info({ userId, sessionId: signedIn.id }, `User logged in`)
        sessionListChanged(userId)
        return signedIn.data.device ?? null
    }

    private planLogin(
        userId: string,
        origin: LoginOrigin,
        auth: SessionAuthState,
        expectedUserToken: string,
    ): LoginPlan {
        const sessionId = crypto.randomUUID()
        return {
            sessionId,
            userId,
            expectedUserToken,
            device: { ...this.deviceFor(origin), publicId: sessionPublicId(sessionId) },
            auth,
            createdAtMs: Date.now(),
        }
    }

    /** The record of a planned session: pending (before the commit) or active. */
    private planRecord(plan: LoginPlan, completionId: string, pending: boolean): SessionInfo {
        return {
            id: plan.sessionId,
            data: withCsrfToken({
                userId: plan.userId,
                userToken: plan.expectedUserToken,
                device: plan.device,
                auth: plan.auth,
                completionId,
                ...(pending ? { pending: true } : {}),
            }),
            createdAt: new Date(plan.createdAtMs).toISOString(),
        }
    }

    private async prepareLogin(
        plan: LoginPlan,
        completionId: string,
        ttlSeconds: Seconds,
    ): Promise<'created' | 'exists' | 'conflict'> {
        return preparePendingSession(
            this.planRecord(plan, completionId, true),
            plan.expectedUserToken,
            ttlSeconds,
            completionId,
            sanitizeRedisKey,
        )
    }

    private async activateLogin(
        plan: LoginPlan,
        ticketKey: string,
        completionId: string,
        hooks: ActivationHooks = {},
    ): Promise<'activated' | 'already' | 'gone'> {
        const record = this.planRecord(plan, completionId, false)
        const outcome = await activatePendingSession({
            ticketKey,
            completionId,
            session: record,
            userToken: plan.expectedUserToken,
            publicId: plan.device.publicId,
            createdAtMs: plan.createdAtMs,
            sanitize: sanitizeRedisKey,
        })
        if (outcome.kind === 'gone') return 'gone'
        if (outcome.kind === 'already' && !outcome.recordExists) return 'gone'
        // The stored record (its CSRF token) when an earlier request activated it.
        const active =
            outcome.kind === 'activated'
                ? record
                : await getSession(plan.sessionId, plan.expectedUserToken)
        if (active === null || active.data.pending === true) return 'gone'
        const replaces = this.info.id !== active.id
        // Р4: everything that can fail and must be repeated runs BEFORE the previous session is
        // deleted. A request that throws from here answers 503 `mfa_completion_pending` without the
        // new cookie, and the browser repeats with the cookie it holds: its session (the CSRF
        // token, the ticket's binding) must still be there for the repeat to get this far.
        // Р8: the recovery cleanup, on every request that finishes the sign-in (it is idempotent);
        // it spares the request's own session, which destroyReplaced deletes under the lock.
        await hooks.cleanup?.(this.info.id)
        // Р4: the effects belong to whichever request first gets this far, the activating one or a
        // repeat after its cleanup or claim threw: one claim per completion. A claim that fails
        // (Redis) throws: the effects stay `pending` for the repeat. A claim whose answer was lost
        // is `done` already: the effects are skipped rather than run twice.
        const claimed = await claimActivationEffects({
            ticketKey,
            completionId,
            sanitize: sanitizeRedisKey,
        })
        if (claimed) {
            logger.info({ userId: plan.userId, sessionId: plan.sessionId }, 'User logged in (MFA)')
            sessionListChanged(plan.userId)
            hooks.onEffects?.()
        }
        // Р13: last of what can fail. A deletion deferred by the lock deleted nothing; the repeat
        // (`already`, the claim `done`) deletes it, without the effects, and issues the cookie.
        if (replaces) {
            const replacedUserId = this.info.data.userId
            await this.destroyReplaced()
            // The list announced with the effects may still have shown a signed-in predecessor.
            if (typeof replacedUserId === 'string' && replacedUserId !== '') {
                sessionListChanged(replacedUserId)
            }
        }
        this.issueActive(active, plan.expectedUserToken)
        return outcome.kind
    }

    /**
     * Deletes the record of the session a sign-in replaces. Any anonymous predecessor — cookie-held
     * or already moved to Redis — is marked before it goes away: a slower response of that session
     * must not re-issue its anonymous cookie over the sign-in's one. A cookie-held session may still
     * have a record: a parallel request can have moved it to Redis.
     *
     * Р13: a signed-in predecessor goes under ITS user's row lock (that may be another account than
     * the new sign-in), as a logout's record does: a role change or an MFA reset that read it under
     * that lock commits first, or sees it gone. When the lock is not taken the sign-in fails with
     * SessionDeletionDeferredError before anything of the new session is written or issued.
     */
    private async destroyReplaced(): Promise<void> {
        const previousId = this.info.id
        const storageToken = this.storageToken
        if (this.cookieHeld || storageToken === ANON_TOKEN) {
            await markAnonSessionSuperseded(previousId, ANON_COOKIE_REFRESH_SECONDS)
            await destroySession(previousId, storageToken)
            return
        }
        const publicId = this.info.data.device?.publicId
        await deleteUnderLock(this.userId() ?? undefined, () =>
            destroySession(previousId, storageToken, publicId),
        )
    }

    /**
     * The request's session becomes `active`, its cookie is issued. Run after the activation's own
     * transition (the Lua script of activatePendingSession), the cleanup, the effects' claim and the
     * deletion of the previous session (destroyReplaced), never inside the transition: a deletion
     * that waits for the lock, or fails, leaves the activation done, and the repeated request (503
     * `mfa_completion_pending`) finds it `already` and deletes again.
     */
    private issueActive(active: SessionInfo, userToken: string): void {
        this.issueStoredCookie(active.id, userToken, sessionConfig.ageSeconds)
        this.setInfo(active)
        this.storageToken = userToken
        this.cookieHeld = false
        this.swapped = true
    }

    private deviceFor(origin: LoginOrigin): Omit<SessionDevice, 'publicId'> {
        if ('inherit' in origin) {
            const { publicId: _publicId, ...kept } = origin.inherit
            return kept
        }
        return {
            ip: this.context.httpData.ip ?? '',
            userAgent: clientUserAgent(this.context),
            method: origin.method,
            ...(origin.method === 'oauth' ? { provider: origin.provider } : {}),
            signedInAt: new Date().toISOString(),
        }
    }

    /** Deletes the current signed-in session and starts a new anonymous one. */
    private async logout(): Promise<boolean> {
        const userToken = this.signedInUserToken()
        if (userToken !== undefined) {
            const { id } = this.info
            const publicId = this.info.data.device?.publicId
            await deleteUnderLock(this.userId() ?? undefined, () =>
                destroySession(id, userToken, publicId),
            )
            logger.info(
                { userId: this.info.data.userId, sessionId: this.info.id },
                `User logged out`,
            )
            const userId = this.info.data.userId
            if (typeof userId === 'string') sessionListChanged(userId)
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

    /**
     * feat-245 (Р4): the second-step ticket id, or null to clear it. feat-257: with its binding
     * cookie (`bind`, required with a ticket), set and cleared together, with the same attributes.
     */
    private setMfaTicketCookie(
        ticketId: string | null,
        maxAgeSeconds: number,
        bind?: string,
    ): void {
        if (ticketId !== null && (bind === undefined || bind === '')) {
            throw new Error('A second-step ticket cookie needs its binding cookie')
        }
        const maxAge = ticketId === null ? 0 : maxAgeSeconds
        const attributes = {
            path: '/',
            httpOnly: true,
            secure: sessionConfig.cookie.secure,
            maxAge,
            sameSite: 'Strict' as const,
            expires: new Date(Date.now() + maxAge * 1000),
        }
        this.context.responseData.setCookie(mfaTicketCookieName(), ticketId ?? '', attributes)
        this.context.responseData.setCookie(
            mfaBindCookieName(),
            ticketId === null ? '' : (bind ?? ''),
            attributes,
        )
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
        this.setCookie(token, sessionConfig.anonAgeSeconds)
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
