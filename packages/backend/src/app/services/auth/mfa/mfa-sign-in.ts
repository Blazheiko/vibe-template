import { Result } from 'better-result'
import { addMs, toMs, nowUnixMs, type UnixMs } from 'shared/brand'
import { normalizeEmail } from '#app/domain/email.js'
import {
    mfaBindValueOf,
    newSessionToken,
    type MfaTicketId,
    type MfaCompletionId,
    type MfaReservationId,
    type MfaAttemptId,
    type MfaBinding,
    type SessionToken,
    rawRecoveryCodeOf,
    newMfaReservationId,
    newMfaCompletionId,
    mfaAttemptIdOf,
    mfaTicketIdOf,
    mfaCompletionIdOf,
    sessionTokenOf,
} from '#app/domain/secrets.js'
import { MFA_REASONS, type SessionAuthState } from 'shared/mfa'
import type { AuthenticationResponse } from 'shared/schemas'

import mfaConfig from '#config/mfa.js'
import { throttlePolicies } from '#config/throttle-policies.js'
import {
    currentTransactionId,
    oauthAccountRepository,
    transactionStatus,
    userRepository,
    webauthnCredentialRepository,
    withTransaction,
    type DbTransaction,
} from '#app/repositories/index.js'
import { isUniqueViolation } from '#app/repositories/db-errors.js'
import { auditService, type RecordedAuditEvent } from '#app/services/audit/audit-service.js'
import { proofHolderOf, type AuditRequest } from '#app/services/audit/audit-actor.js'
import { authSuccessPayload, type AuthSuccessPayload } from '#app/services/auth/auth-success.js'
import { enforceThrottle } from '#app/services/auth/enforce-throttle.js'
import { notifyNewSignIn } from '#app/services/auth/new-sign-in-notice.js'
import { wsSessionRevocation } from '#app/services/auth/ws-session-revocation.js'
import {
    badRequest,
    completionPending,
    rateLimited,
    serviceUnavailable,
    sessionRevoked,
    unauthorized,
    type AppError,
    type AppResult,
} from '#app/services/shared/errors.js'
import type { Auth, LoginOrigin, LoginPlan, Session } from '#vendor/types/types.js'
import logger from '#vendor/utils/logger.js'
import {
    isRedisUnavailable,
    RedisUnavailableError,
} from '#vendor/utils/network/errors/redis-unavailable-error.js'
import { destroyAllSessions, destroySession } from '#vendor/utils/session/redis-session-storage.js'
import {
    classifyLockFailure,
    SessionDeletionDeferredError,
} from '#vendor/utils/session/session-deletion-lock.js'
import { loadMfaFactors } from './mfa-account.js'
import {
    mfaBinding,
    mfaTicketStore,
    newBindValue,
    newTicketId,
    type CheckedChallenge,
    type MfaTicket,
    type PendingOAuthLink,
    type ReopenOutcome,
    type ReserveOutcome,
} from './mfa-ticket.js'
import { announceMfaChange } from './mfa-notice.js'
import { recoveryCodes } from './recovery-codes.js'
import { totpService } from './totp-service.js'
import { passkeyTicketChallenges, ticketHash } from './passkey-login-challenges.js'
import { recordCounterRegression } from './passkey-sign-in.js'
import {
    authenticationOptions,
    ceremonyBinding,
    fromBase64Url,
    verifyWebAuthnCeremony,
} from './webauthn-ceremony.js'
import { asUserId, type UserId, type PasskeyId } from '#app/domain/ids.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р4): the second sign-in step. The first factor
// (password or OAuth) of an account with MFA opens a ticket instead of a session; the session is
// created only by the request that captures the ticket with a right second proof, planned and
// written as pending inside the transaction that spends the proof, and made active after the
// commit is known. A lost answer, a failed activation or an unknown commit is finished by the
// same request repeated (continuation).

export type SecondStepMethod = 'webauthn' | 'totp' | 'recovery_code'

export interface SecondStepRequired {
    status: 'mfa_required'
    methods: SecondStepMethod[]
}

export interface SignInContext {
    auth: Auth
    session: Session
}

const ticketInvalid = (): AppError => unauthorized('Sign in again', MFA_REASONS.mfaTicketInvalid)
const invalidCode = (): AppError => unauthorized('Invalid code', MFA_REASONS.invalidCode)
const attemptExpired = (): AppError =>
    unauthorized('Try the code again', MFA_REASONS.mfaAttemptExpired)

/** Thrown inside the transaction to roll it back with a decided answer. */
class Abort extends Error {
    constructor(
        readonly kind: 'wrong' | 'revoked' | 'used' | 'expired' | 'stale' | 'gone' | 'error',
        readonly error?: AppError,
    ) {
        super(kind)
        this.name = 'MfaAbort'
    }
}

/**
 * ADR 0004 (best effort): a step whose failure changes nothing the request answers. It is logged
 * and answered by its fallback; the ticket and the pending session lapse with their TTL.
 */
const bestEffort = <T>(
    work: Promise<T>,
    fallback: T,
    message: string,
    fields: Record<string, unknown>,
): Promise<T> =>
    work.catch((err: unknown) => {
        logger.warn({ err, ...fields }, message)
        return fallback
    })

const field = (value: unknown, key: string): unknown =>
    typeof value === 'object' && value !== null && key in value
        ? (value as Record<string, unknown>)[key]
        : undefined

/** pg's query_timeout: the query got no answer in time (Drizzle keeps it as the `cause`). */
const isQueryTimeout = (err: unknown): boolean => {
    let current: unknown = err
    for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
        const message = field(current, 'message')
        if (typeof message === 'string' && message.startsWith('Query read timeout')) return true
        current = field(current, 'cause')
    }
    return false
}

/**
 * Р4: a failure of the activation that the repeat of the same request can outlive, so it answers
 * 503 `mfa_completion_pending` (the client repeats `continue`): Redis unavailable, the replaced
 * session's record left by its lock (SessionDeletionDeferredError), and PostgreSQL that did not
 * answer: no connection, a broken one, a cut wait (classifyLockFailure: busy, unreachable,
 * connection_lost) or a query timeout. Anything else (a bug, a Lua reply error) is thrown: a 500
 * instead of an answer the client would repeat for ever.
 */
const isRepeatableFailure = (err: unknown): boolean =>
    isRedisUnavailable(err) ||
    err instanceof SessionDeletionDeferredError ||
    classifyLockFailure(err) !== 'other' ||
    isQueryTimeout(err)

const methodsOf = (account: { totp: unknown; passkeys: number }): SecondStepMethod[] => {
    const methods: SecondStepMethod[] = []
    // feat-246: a passkey first, it is the stronger and the quicker one.
    if (account.passkeys > 0) methods.push('webauthn')
    if (account.totp !== undefined) methods.push('totp')
    methods.push('recovery_code')
    return methods
}

/**
 * Р4: after the first factor. Answers null when the account has no second factor (the caller
 * signs in as before), or the second step it opened: a ticket and its cookie.
 */
/** The ticket id of the mfa_ticket cookie, if the browser sent one (an empty one is none). */
const mfaTicketCookieOf = (text: string | undefined): MfaTicketId | undefined =>
    text === undefined || text === '' ? undefined : mfaTicketIdOf(text)

export async function startSecondStepIfRequired(
    auth: Auth,
    user: { id: UserId; sessionToken: SessionToken },
    origin: Exclude<LoginOrigin, { inherit: unknown }>,
    extras: { pendingOAuthLink?: PendingOAuthLink } = {},
): Promise<AppResult<SecondStepRequired | null>> {
    const account = await loadMfaFactors(user.id)
    if (account.totp === undefined && account.passkeys === 0) return Result.ok(null)
    const ticketId = newTicketId()
    // feat-257 (docs/plan/mfa-review-fixes-7-plan.md, item 2): bound to a cookie of its own, not
    // to the session: the activation deletes the previous session, and a repeat after a lost
    // answer comes with that session's cookie (or a new anonymous one) and must still be this
    // browser's.
    const bindValue = newBindValue()
    const ticket: MfaTicket = {
        v: 1,
        state: 'open',
        userId: String(user.id),
        userTokenAtStart: user.sessionToken,
        binding: mfaBinding(bindValue),
        origin,
        firstFactor: origin.method === 'oauth' ? 'oauth' : 'pwd',
        ...(extras.pendingOAuthLink !== undefined
            ? { pendingOAuthLink: extras.pendingOAuthLink }
            : {}),
        failures: 0,
        reservations: [],
        settled: [],
    }
    // ADR 0004: a Redis failure throws (503 by classifyError); no cookie was set before it.
    await mfaTicketStore.create(ticketId, ticket, mfaConfig.ticketTtlSeconds)
    auth.setMfaTicketCookie(ticketId, mfaConfig.ticketTtlSeconds, bindValue)
    return Result.ok({ status: 'mfa_required', methods: methodsOf(account) })
}

export type SecondStepState =
    { status: 'mfa_required'; methods: SecondStepMethod[]; completing?: true } | { status: 'none' }

/**
 * Р4: POST /auth/mfa/state. The sign-in page keeps the second step of a password sign-in in
 * memory; after a reload it asks here before a new sign-in, so the password is not typed again
 * (a new ticket) while this browser's ticket still waits for its second step or is finishing.
 * Answers the methods for a ticket of THIS browser (the cookie and the binding, as `continue`
 * checks them), with `completing` once an attempt was confirmed; `none` for no cookie, an
 * expired ticket or one bound to another browser, and for an account that lost its factors
 * meanwhile (the password then signs in alone). Nothing is reserved, counted or changed.
 */
export async function secondStepState(context: SignInContext): Promise<AppResult<SecondStepState>> {
    const none = Result.ok<SecondStepState>({ status: 'none' })
    const ticketId = mfaTicketCookieOf(context.auth.getMfaTicketCookie())
    const bindValue = context.auth.getMfaBindCookie()
    if (ticketId === undefined || ticketId === '' || bindValue === undefined || bindValue === '')
        return none
    const ticket = await mfaTicketStore.read(ticketId)
    if (ticket?.binding !== mfaBinding(mfaBindValueOf(bindValue))) return none
    const account = await loadMfaFactors(asUserId(ticket.userId))
    if (account.totp === undefined && account.passkeys === 0) return none
    return Result.ok({
        status: 'mfa_required',
        methods: methodsOf(account),
        ...(ticket.state !== 'open' ? { completing: true as const } : {}),
    })
}

/** The session the second step creates (Р2, Р8). */
function plannedAuth(ticket: MfaTicket, method: SecondStepMethod, nowMs: UnixMs): SessionAuthState {
    const at = new Date(nowMs).toISOString()
    const first = ticket.firstFactor
    if (method === 'recovery_code') {
        return {
            v: 1,
            amr: [first, 'recovery'],
            aal: 1,
            authenticatedAt: at,
            verified: { [first]: at },
            recovery: {
                startedAt: at,
                expiresAt: new Date(
                    addMs(nowMs, toMs(mfaConfig.recoveryWindowSeconds)),
                ).toISOString(),
            },
        }
    }
    const second = method === 'webauthn' ? 'webauthn' : 'otp'
    return {
        v: 1,
        amr: [first, second],
        aal: 2,
        authenticatedAt: at,
        verified: { [first]: at, [second]: at },
    }
}

/**
 * feat-246 (Р6): POST /auth/mfa/webauthn/options. The options of a signature with a key of the
 * ticket's user, the challenge bound to the ticket (`mfa:<hash>`, Р5). Nothing is reserved: the
 * answer goes through POST /auth/mfa/verify like a code.
 */
export async function secondStepPasskeyOptions(
    context: SignInContext,
): Promise<AppResult<{ options: object }>> {
    const ticketId = mfaTicketCookieOf(context.auth.getMfaTicketCookie())
    const bindValue = context.auth.getMfaBindCookie()
    if (ticketId === undefined || ticketId === '' || bindValue === undefined || bindValue === '') {
        return Result.err(ticketInvalid())
    }
    const ticket = await mfaTicketStore.read(ticketId)
    const ttl = await mfaTicketStore.ttl(ticketId)
    if (ticket?.binding !== mfaBinding(mfaBindValueOf(bindValue))) {
        return Result.err(ticketInvalid())
    }
    // Р4: an attempt of this ticket was confirmed and is finishing. A new challenge would not
    // help: the browser repeats the same verify request, which continues the confirmed one.
    if (ticket.state !== 'open') return Result.err(completionPending())
    const keys = await webauthnCredentialRepository.listByUserId(asUserId(ticket.userId))
    if (keys.length === 0) {
        return Result.err(badRequest('This account has no passkey', 'proof_unavailable'))
    }
    const options = await authenticationOptions(keys)
    await passkeyTicketChallenges.issue(ticketId, options.challenge, ttl)
    return Result.ok({ options })
}

/** Р4: the fate of a transaction whose COMMIT got no answer; a failed read is undetermined. */
export async function readTransactionStatus(
    xid: string,
): Promise<'committed' | 'aborted' | 'undetermined'> {
    try {
        return await transactionStatus(xid)
    } catch (err) {
        logger.warn({ err }, 'Transaction status not read')
        return 'undetermined'
    }
}

/**
 * `attemptId` (feat-256, item 6): the browser's id of this logical attempt, sent again only with a
 * repeat of the same request. A wrong proof is counted once per attempt; without it every request
 * is an attempt of its own.
 */
type ProofInput =
    | { method: 'totp' | 'recovery_code'; code: string; attemptId?: string }
    | { method: 'webauthn'; response: AuthenticationResponse; attemptId?: string }

/** A proof, or `continue`: finish the sign-in this browser's ticket already confirmed. */
export type SecondStepInput = ProofInput | { method: 'continue' }

export interface SecondStepDeps {
    /**
     * The clock. Read at the start of the request (the reservation, the TOTP window) and again at
     * the capture, so a test can move time between the two.
     */
    now?: () => UnixMs
    /** Test seam: called after the attempt captured the ticket and before COMMIT. */
    beforeCommit?: () => Promise<void>
    /** Test seam: the commit outcome as the caller saw it. */
    commitSeen?: (outcome: 'committed' | 'failed') => void
}

/**
 * Р4: POST /auth/mfa/verify. The first request with a right proof captures the ticket and signs
 * in; a repeat of the same request finishes what an earlier one confirmed.
 */
export async function completeSecondStep(
    context: SignInContext,
    input: SecondStepInput,
    request: AuditRequest,
    deps: SecondStepDeps = {},
): Promise<AppResult<AuthSuccessPayload>> {
    const nowMs = deps.now?.() ?? nowUnixMs()
    const ticketId = mfaTicketCookieOf(context.auth.getMfaTicketCookie())
    const bindValue = context.auth.getMfaBindCookie()
    if (ticketId === undefined || ticketId === '' || bindValue === undefined || bindValue === '') {
        return Result.err(ticketInvalid())
    }
    const binding = mfaBinding(mfaBindValueOf(bindValue))
    if (input.method === 'continue') {
        return continueByRequest(context, ticketId, binding, input, request, deps)
    }
    const reservationId = newMfaReservationId()
    const attemptId = mfaAttemptIdOf(input.attemptId ?? reservationId)
    const reservationTtlMs = toMs(mfaConfig.reservationTtlSeconds)

    const reserved: ReserveOutcome = await mfaTicketStore.reserve(
        ticketId,
        binding,
        reservationId,
        nowMs,
        reservationTtlMs,
        attemptId,
    )
    if (reserved.kind === 'invalid') {
        context.auth.setMfaTicketCookie(null, 0)
        return Result.err(ticketInvalid())
    }
    if (reserved.kind === 'busy') return Result.err(ticketInvalid())
    // feat-256: a repeat of an attempt whose wrong proof was counted (its answer was lost): the
    // same answer, nothing counted again and nothing checked again.
    if (reserved.kind === 'failed') return Result.err(invalidCode())
    if (reserved.kind === 'completing' || reserved.kind === 'activated') {
        return continueCompletion(context, ticketId, reserved.ticket, input, request, deps)
    }
    return attempt(
        context,
        ticketId,
        reserved.ticket,
        { reservationId, attemptId },
        input,
        request,
        deps,
        nowMs,
    )
}

/**
 * Р4: `{ method: 'continue' }`. The browser lost the answer of a confirmed attempt (or reloaded
 * the page) and has no proof to repeat. Nothing is reserved and nothing is counted: the request
 * only finishes a ticket that left `open`. An `open` ticket was never captured, so the browser
 * gives a proof: 401 `mfa_attempt_expired`, the answer the form already treats as "ask again,
 * nothing counted". The route's rate limit bounds it like any other verify request; the per-user
 * code budget is not spent, as by the repeat of a confirmed request, since no proof is checked.
 */
async function continueByRequest(
    context: SignInContext,
    ticketId: MfaTicketId,
    binding: MfaBinding,
    input: SecondStepInput,
    request: AuditRequest,
    deps: SecondStepDeps,
): Promise<AppResult<AuthSuccessPayload>> {
    const ticket = await mfaTicketStore.read(ticketId)
    if (ticket?.binding !== binding) {
        context.auth.setMfaTicketCookie(null, 0)
        return Result.err(ticketInvalid())
    }
    if (ticket.state === 'open') return Result.err(attemptExpired())
    return continueCompletion(context, ticketId, ticket, input, request, deps)
}

async function attempt(
    context: SignInContext,
    ticketId: MfaTicketId,
    ticket: MfaTicket,
    ids: { reservationId: MfaReservationId; attemptId: MfaAttemptId },
    input: ProofInput,
    request: AuditRequest,
    deps: SecondStepDeps,
    nowMs: UnixMs,
): Promise<AppResult<AuthSuccessPayload>> {
    const { reservationId, attemptId } = ids
    const userId = asUserId(ticket.userId)
    const release = async (): Promise<void> => {
        try {
            await mfaTicketStore.settle(ticketId, reservationId, 'release')
        } catch (err) {
            logger.warn({ err }, 'Reservation not released; it lapses by itself')
        }
    }

    const throttle = await enforceThrottle(
        throttlePolicies.mfaVerifyUser,
        ticket.userId,
        rateLimited('Too many codes. Please try again later.'),
    )
    if (Result.isError(throttle)) {
        await release()
        return Result.err(throttle.error)
    }

    const completionId = newMfaCompletionId()
    // Written inside the transaction callback, read after it: an object, so the reads after the
    // callback are not narrowed to the initial values.
    const progress: {
        captured: boolean
        callbackDone: boolean
        plan?: LoginPlan
        xid?: string
        events: RecordedAuditEvent[]
        linkEvents: RecordedAuditEvent[]
    } = { captured: false, callbackDone: false, events: [], linkEvents: [] }
    const recovery = input.method === 'recovery_code'
    const actor = proofHolderOf('recovery_code', request)

    // feat-246: a passkey is checked before the transaction (no writes); the transaction spends
    // its counter, so a rollback gives it back.
    let passkey: {
        credentialId: PasskeyId
        newCounter: bigint
        challenge: CheckedChallenge
    } | null = null
    /**
     * feat-256 (item 6): a wrong proof counted once per logical attempt. A Redis failure is not a
     * refusal (ADR 0004): it reaches the error handler (503), and the repeat with the same
     * `attemptId` counts it, or finds it counted. A passkey whose challenge was spent or replaced
     * meanwhile counts nothing (`stale`): the browser runs a new ceremony.
     */
    const countFailure = async (
        challenge: CheckedChallenge | null,
    ): Promise<AppResult<AuthSuccessPayload>> => {
        const settled = await mfaTicketStore.settle(ticketId, reservationId, 'failure', {
            attemptId,
            challenge,
        })
        if (settled === 'stale') return Result.err(attemptExpired())
        if (settled === 'deleted') context.auth.setMfaTicketCookie(null, 0)
        return Result.err(invalidCode())
    }
    if (input.method === 'webauthn') {
        let checked: Awaited<ReturnType<typeof checkSecondStepPasskey>>
        try {
            checked = await checkSecondStepPasskey(ticketId, ticket, input.response, request)
        } catch (err) {
            // ADR 0004: the failure reaches the error handler (503 for Redis, else 500); the
            // reservation is given back first, so it does not hold a place until it lapses.
            await release()
            throw err
        }
        if (checked.kind === 'stale') {
            // The challenge is gone or spent (an earlier attempt took it, then rolled back or
            // lapsed): not a wrong proof. Nothing counted; the browser runs a new ceremony.
            await release()
            return Result.err(attemptExpired())
        }
        if (checked.kind === 'wrong') return countFailure(checked.challenge)
        passkey = { ...checked.assertion, challenge: checked.challenge }
    }

    try {
        await withTransaction(async (tx) => {
            const locked = await userRepository.lockById(userId, tx)
            if (locked?.sessionToken !== ticket.userTokenAtStart) {
                throw new Abort('revoked')
            }
            if (input.method === 'recovery_code') {
                if (!(await recoveryCodes.consume(userId, rawRecoveryCodeOf(input.code), tx)))
                    throw new Abort('wrong')
            } else if (input.method === 'webauthn') {
                if (passkey === null) throw new Abort('wrong')
                const counted = await webauthnCredentialRepository.recordUse(
                    passkey.credentialId,
                    passkey.newCounter,
                    tx,
                )
                if (counted !== 'advanced') throw new Abort('wrong')
            } else {
                const verified = await totpService.verify(userId, input.code, {
                    now: nowMs,
                    executor: tx,
                    throttle: false,
                })
                if (Result.isError(verified)) {
                    const reason = 'reason' in verified.error ? verified.error.reason : undefined
                    if (reason === MFA_REASONS.invalidCode) throw new Abort('wrong')
                    throw new Abort('error', verified.error)
                }
            }
            const xid = await currentTransactionId(tx)
            progress.xid = xid
            const expectedUserToken = recovery ? newSessionToken() : locked.sessionToken
            const plan = context.auth.planLogin(
                ticket.userId,
                ticket.origin,
                plannedAuth(ticket, input.method, nowMs),
                expectedUserToken,
            )
            progress.plan = plan
            // Р4: the reservation is checked against the clock of the capture itself: a factor check
            // or a row lock that outlasted the reservation TTL rolls the proof back (401).
            const capture = await mfaTicketStore.capture(
                ticketId,
                reservationId,
                deps.now?.() ?? nowUnixMs(),
                toMs(mfaConfig.reservationTtlSeconds),
                { completionId, xid, plan },
                passkey?.challenge ?? null,
            )
            if (capture !== 'ok') throw new Abort(capture)
            progress.captured = true

            if (recovery) {
                // Р8: the lost device's sessions end with the recovery sign-in.
                const rotated = await userRepository.updateIfSessionToken(
                    userId,
                    locked.sessionToken,
                    { sessionToken: expectedUserToken },
                    tx,
                )
                if (rotated === undefined) throw new Abort('revoked')
            } else if (ticket.pendingOAuthLink !== undefined && ticket.pendingOAuthLink !== null) {
                // Row 16: a link made by this sign-in exists only once the second step passed.
                progress.linkEvents = await createPendingLink(
                    tx,
                    userId,
                    ticket.pendingOAuthLink,
                    request,
                )
            }

            const ttl = Math.max(1, await mfaTicketStore.ttl(ticketId))
            const prepared = await context.auth.prepareLogin(plan, completionId, ttl)
            if (prepared === 'conflict') throw new Error('pending session conflict')

            if (recovery) {
                const stamp = await auditService.stamp(tx)
                progress.events = await auditService.record(tx, stamp, actor, [
                    {
                        action: 'auth.mfa.recovery_code.used',
                        targetId: String(userId),
                        targetUserId: userId,
                        input: { remaining: await recoveryCodes.remaining(userId, tx) },
                    },
                ])
            }
            if (deps.beforeCommit !== undefined) await deps.beforeCommit()
            progress.callbackDone = true
        })
        deps.commitSeen?.('committed')
    } catch (err) {
        deps.commitSeen?.('failed')
        if (err instanceof Abort) {
            switch (err.kind) {
                case 'wrong':
                    return countFailure(passkey?.challenge ?? null)
                case 'revoked': {
                    await release()
                    // A recovery sign-in of a parallel attempt rotated the token: that attempt
                    // won, and its ticket stays for its continuation. feat-256: one atomic step
                    // (DELETE_IF_OPEN_LUA), so an attempt that captures it between a read and a
                    // delete keeps it. feat-258 (8.1): a Redis failure here is an unknown outcome,
                    // not `absent`: it reaches the error handler (503, ADR 0004) with both MFA
                    // cookies kept, so the repeat still finishes a sign-in the parallel attempt
                    // confirmed. The cookies go only once the ticket is known deleted or absent.
                    const deleted = await mfaTicketStore.deleteIfOpen(ticketId, ticket.binding)
                    if (deleted === 'completing' || deleted === 'activated') {
                        return Result.err(
                            unauthorized('Signed in already', MFA_REASONS.mfaTicketUsed),
                        )
                    }
                    context.auth.setMfaTicketCookie(null, 0)
                    return Result.err(sessionRevoked())
                }
                case 'used':
                    return Result.err(unauthorized('Signed in already', MFA_REASONS.mfaTicketUsed))
                case 'expired':
                case 'stale':
                    // A lapsed reservation, or a passkey challenge spent or replaced meanwhile:
                    // nothing was counted, the proof was not spent.
                    await release()
                    return Result.err(attemptExpired())
                case 'gone':
                    context.auth.setMfaTicketCookie(null, 0)
                    return Result.err(ticketInvalid())
                case 'error':
                    await release()
                    return Result.err(err.error ?? serviceUnavailable())
            }
        }
        const { plan, xid } = progress
        if (progress.callbackDone && plan !== undefined && xid !== undefined) {
            // The COMMIT itself got no answer: what happened is read from PostgreSQL.
            logger.warn({ err }, 'Second-step commit outcome unknown; reconciling')
            return reconcile(context, ticketId, ticket, plan, completionId, xid)
        }
        // A known rollback: the proof was not spent; the same code can be sent again. The
        // compensation runs here, then the failure reaches the error handler (ADR 0004: 503 for
        // Redis, else 500), which logs it.
        if (progress.captured) {
            await discardPending(plan)
            const reopened = await reopenQuietly(ticketId, completionId, ticket.userId)
            if (reopened === 'deleted') {
                // feat-256 (item 1): late failures brought the ticket to the limit while this
                // attempt held it; the rollback deleted it. Answered, not thrown: an error
                // answer carries the session cookie only, and the ticket cookie must be cleared.
                logger.error({ err, userId: ticket.userId }, 'Second step rolled back')
                context.auth.setMfaTicketCookie(null, 0)
                return Result.err(ticketInvalid())
            }
        } else {
            await release()
        }
        throw err
    }

    auditService.logCommitted(actor.logger, progress.events)
    auditService.logCommitted(request.logger, progress.linkEvents)
    if (progress.plan === undefined) return Result.err(serviceUnavailable())
    return activate(context, ticketId, ticket, progress.plan, completionId)
}

/**
 * Row 16 of Р3: the link a sign-in decided, written by the transaction of the second step. An
 * identity linked to another account meanwhile is left out (savepoint): the sign-in goes on.
 */
async function createPendingLink(
    tx: DbTransaction,
    userId: UserId,
    link: PendingOAuthLink,
    request: AuditRequest,
): Promise<RecordedAuditEvent[]> {
    const { proof, ...identity } = link
    try {
        await tx.transaction(async (savepoint) => {
            await oauthAccountRepository.create(
                {
                    userId,
                    ...identity,
                    // The ticket keeps the address as text (JSON in Redis).
                    providerEmail:
                        identity.providerEmail === null
                            ? null
                            : normalizeEmail(identity.providerEmail),
                },
                savepoint,
            )
        })
    } catch (err) {
        if (!isUniqueViolation(err)) throw err
        logger.warn({ provider: identity.provider }, 'Pending OAuth link taken meanwhile; skipped')
        return []
    }
    const stamp = await auditService.stamp(tx)
    return auditService.record(tx, stamp, proofHolderOf(proof, request), [
        {
            action: 'auth.oauth.linked',
            targetId: String(userId),
            targetUserId: userId,
            input: { provider: identity.provider },
        },
    ])
}

/**
 * A known rollback takes the ticket back to `open`. A failure leaves it `completing`: the next
 * request reads the transaction's status (aborted) and reopens it.
 */
function reopenQuietly(
    ticketId: MfaTicketId,
    completionId: MfaCompletionId,
    userId: string,
): Promise<ReopenOutcome> {
    return bestEffort(
        mfaTicketStore.reopen(ticketId, completionId),
        'no' as const,
        'Ticket not reopened after the rollback; the next request reopens it',
        { userId },
    )
}

async function discardPending(plan: LoginPlan | undefined): Promise<void> {
    if (plan === undefined) return
    try {
        await destroySession(plan.sessionId, plan.expectedUserToken)
    } catch (err) {
        logger.warn({ err }, 'Pending session not removed; it expires with the ticket')
    }
}

async function reconcile(
    context: SignInContext,
    ticketId: MfaTicketId,
    ticket: MfaTicket,
    plan: LoginPlan,
    completionId: MfaCompletionId,
    xid: string,
): Promise<AppResult<AuthSuccessPayload>> {
    const status = await readTransactionStatus(xid)
    if (status === 'committed') return activate(context, ticketId, ticket, plan, completionId)
    if (status === 'aborted') {
        await discardPending(plan)
        const reopened = await reopenQuietly(ticketId, completionId, ticket.userId)
        if (reopened === 'deleted') {
            context.auth.setMfaTicketCookie(null, 0)
            return Result.err(ticketInvalid())
        }
        return Result.err(serviceUnavailable())
    }
    return Result.err(completionPending())
}

/** Р4: a repeat of the request after the ticket left `open`. */
async function continueCompletion(
    context: SignInContext,
    ticketId: MfaTicketId,
    ticket: MfaTicket,
    input: SecondStepInput,
    request: AuditRequest,
    deps: SecondStepDeps,
): Promise<AppResult<AuthSuccessPayload>> {
    const { plan, xid } = ticket
    const completionId =
        ticket.completionId === undefined ? undefined : mfaCompletionIdOf(ticket.completionId)
    if (plan === undefined || completionId === undefined) return Result.err(ticketInvalid())
    if (ticket.state === 'activated') {
        return activate(context, ticketId, ticket, plan, completionId)
    }
    if (xid === undefined) return Result.err(completionPending())
    const status = await readTransactionStatus(xid)
    if (status === 'committed') return activate(context, ticketId, ticket, plan, completionId)
    if (status === 'aborted') {
        // The confirmed attempt rolled back after all: the ticket opens again and this request,
        // which carries the code, is an attempt of its own. A passkey answer's challenge was
        // spent by the rolled-back attempt: that attempt answers 401 `mfa_attempt_expired`
        // without counting a failure, and the browser runs a new ceremony. A `continue` carries
        // no proof: it answers the same, and the browser gives one.
        await discardPending(plan)
        const reopened = await reopenQuietly(ticketId, completionId, ticket.userId)
        if (reopened === 'deleted') {
            // feat-256 (item 1): late failures reached the limit while it was captured.
            context.auth.setMfaTicketCookie(null, 0)
            return Result.err(ticketInvalid())
        }
        if (reopened === 'no') return Result.err(completionPending())
        if (input.method === 'continue') return Result.err(attemptExpired())
        return completeSecondStep(context, input, request, { ...deps })
    }
    return Result.err(completionPending())
}

/**
 * Р4: makes the planned session active, once the commit is known. Checks first that the
 * session_token is still the one the sign-in was confirmed under (a logout-all, a password change
 * or an MFA reset after the commit wins).
 */
async function activate(
    context: SignInContext,
    ticketId: MfaTicketId,
    ticket: MfaTicket,
    plan: LoginPlan,
    completionId: MfaCompletionId,
): Promise<AppResult<AuthSuccessPayload>> {
    const userId = asUserId(plan.userId)
    let current: string | undefined
    try {
        current = await userRepository.findSessionToken(userId)
    } catch (err) {
        if (!isRepeatableFailure(err)) throw err
        logger.warn({ err }, 'Session token not read before the activation')
        return Result.err(completionPending())
    }
    if (current !== plan.expectedUserToken) {
        await discardPending(plan)
        await bestEffort(
            mfaTicketStore.delete(ticketId),
            undefined,
            'Ticket of a revoked sign-in not deleted; it lapses with its TTL',
            { userId: plan.userId },
        )
        context.auth.setMfaTicketCookie(null, 0)
        return Result.err(sessionRevoked())
    }
    const recoveryExpiry = plan.auth.recovery?.expiresAt
    if (recoveryExpiry !== undefined && Date.parse(recoveryExpiry) <= nowUnixMs()) {
        await bestEffort(
            mfaTicketStore.delete(ticketId),
            undefined,
            'Ticket of an expired recovery sign-in not deleted; it lapses with its TTL',
            { userId: plan.userId },
        )
        context.auth.setMfaTicketCookie(null, 0)
        return Result.err(ticketInvalid())
    }
    // feat-257 (docs/plan/mfa-review-fixes-7-plan.md, item 7): what the answer needs is read
    // before the activation issues the new session's cookie. Nothing after that cookie may fail
    // the request: a 5xx carrying a working cookie would tell the form the sign-in failed.
    let user: Awaited<ReturnType<typeof userRepository.findById>>
    try {
        user = await userRepository.findById(userId)
    } catch (err) {
        if (!isRepeatableFailure(err)) throw err
        logger.warn({ err }, 'User not read before the activation')
        return Result.err(completionPending())
    }
    if (user === undefined) return Result.err(sessionRevoked())

    let outcome: 'activated' | 'already' | 'gone'
    const recovery = plan.auth.recovery !== undefined
    try {
        outcome = await context.auth.activateLogin(
            plan,
            mfaTicketStore.keyOf(ticketId),
            completionId,
            {
                // Р8: on every request that finishes a recovery sign-in, not only the claiming
                // one: a cleanup that failed (Redis) answers mfa_completion_pending and the
                // repeat runs it again, before the success answer.
                ...(recovery
                    ? {
                          cleanup: (currentSessionId: string): Promise<void> =>
                              endOtherSessions(ticket, plan, currentSessionId),
                      }
                    : {}),
                // At most once per completion: only the request that claims the effects sends
                // these (the activating one, or the repeat of one whose cleanup or claim failed
                // and answered mfa_completion_pending), before the previous session is deleted.
                onEffects: () => {
                    notifyNewSignIn(userId, plan.device, { mail: true })
                    if (recovery) announceMfaChange(userId, 'recovery_code_used')
                },
            },
        )
    } catch (err) {
        if (!isRepeatableFailure(err)) throw err
        logger.warn({ err }, 'Activation failed; the same request finishes it')
        return Result.err(completionPending())
    }
    if (outcome === 'gone') {
        context.auth.setMfaTicketCookie(null, 0)
        return Result.err(ticketInvalid())
    }

    // A WebSocket token Redis could not issue is left empty: main/init, which the client sends
    // right after the sign-in, issues it.
    return Result.ok(await authSuccessPayload(user, context.session, { wsToken: 'optional' }))
}

/**
 * Р8: the sockets and the sessions of the token a recovery sign-in rotated. Idempotent: a repeat
 * closes what connected since with that token and finds no records left. Only the rotated token:
 * a session signed in with the new one between two attempts keeps its sockets. The browser's own
 * session is spared even when it carries the rotated token: the activation deletes it under the
 * lock, last, so a repeat still finds it. A cleanup that Redis stopped part-way throws, so the
 * request does not answer success.
 */
async function endOtherSessions(
    ticket: MfaTicket,
    plan: LoginPlan,
    currentSessionId: string,
): Promise<void> {
    wsSessionRevocation.closeUserConnections(plan.userId, {
        exceptSessionId: plan.sessionId,
        userToken: sessionTokenOf(ticket.userTokenAtStart),
    })
    const cleanup = await destroyAllSessions(ticket.userTokenAtStart, {
        keepSessionId: currentSessionId,
    })
    if (!cleanup.complete) {
        // A Redis failure part-way: answered 503 mfa_completion_pending, the repeat runs it again.
        throw new RedisUnavailableError('Sessions of the rotated token not all deleted')
    }
}

/**
 * Р4: the browser came back with the new session: its ticket is not needed any more. The cookie
 * is cleared only with the ticket (or when there is none left); a ticket of another completion
 * is a newer second step of this browser (a request of the older session while it runs), so it
 * and its cookie stay. A Redis failure throws (the hook logs it) and keeps the cookie too.
 */
export async function retireCompletedTicket(
    auth: Auth,
    completionId: MfaCompletionId,
): Promise<void> {
    const ticketId = mfaTicketCookieOf(auth.getMfaTicketCookie())
    if (ticketId === undefined || ticketId === '') return
    const outcome = await mfaTicketStore.retire(ticketId, completionId)
    if (outcome === 'foreign') return
    auth.setMfaTicketCookie(null, 0)
}

/**
 * feat-246 (Р6): the passkey answer of a second step, checked against the ticket's challenge and
 * a key of the ticket's user. 'wrong' counts as a failed attempt of the ticket; 'stale' (no
 * challenge left: never asked, spent by an earlier attempt, or lapsed) does not.
 */
async function checkSecondStepPasskey(
    ticketId: MfaTicketId,
    ticket: MfaTicket,
    response: AuthenticationResponse,
    request: AuditRequest,
): Promise<
    | {
          kind: 'ok'
          assertion: { credentialId: PasskeyId; newCounter: bigint }
          challenge: CheckedChallenge
      }
    | { kind: 'wrong'; challenge: CheckedChallenge }
    | { kind: 'stale' }
> {
    // feat-256 (item 6): read, not taken. The failure count or the capture spends it, atomically
    // and only while it is still this value: a count whose answer was lost is not repeated.
    const value = await passkeyTicketChallenges.peek(ticketId)
    if (value === null) return { kind: 'stale' }
    const challenge: CheckedChallenge = { key: passkeyTicketChallenges.keyOf(ticketId), value }
    const wrong = { kind: 'wrong' as const, challenge }
    const userId = asUserId(ticket.userId)
    const credential = await webauthnCredentialRepository.findByCredentialId(
        fromBase64Url(response.id),
    )
    if (credential === undefined) return wrong
    const binding = ceremonyBinding('mfa', ticketHash(ticketId))
    const verified = await verifyWebAuthnCeremony({
        purpose: 'mfa',
        stored: { challenge: value, binding },
        expectedBinding: binding,
        response,
        credential,
        expectedUserId: userId,
        expectedUserHandle: await webauthnCredentialRepository.userHandleOf(userId),
    })
    if (!verified.ok) {
        if (verified.failure === 'counter_regressed') {
            await recordCounterRegression(credential, 'mfa', request)
        }
        return wrong
    }
    return 'assertion' in verified
        ? { kind: 'ok', assertion: verified.assertion, challenge }
        : wrong
}
