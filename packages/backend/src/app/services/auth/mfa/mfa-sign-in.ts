import { Result } from 'better-result'
import { nanoid } from 'nanoid'
import { MFA_REASONS, type SessionAuthState } from 'shared/mfa'

import mfaConfig from '#config/mfa.js'
import { throttlePolicies } from '#config/throttle-policies.js'
import {
    currentTransactionId,
    oauthAccountRepository,
    transactionStatus,
    userRepository,
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
import { userNotificationService } from '#app/services/notifications/user-notification-service.js'
import {
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
import { destroyAllSessions, destroySession } from '#vendor/utils/session/redis-session-storage.js'
import { loadMfaFactors } from './mfa-account.js'
import {
    mfaBinding,
    mfaTicketStore,
    newTicketId,
    type MfaTicket,
    type PendingOAuthLink,
    type ReserveOutcome,
} from './mfa-ticket.js'
import { recoveryCodes } from './recovery-codes.js'
import { totpService } from './totp-service.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р4): the second sign-in step. The first factor
// (password or OAuth) of an account with MFA opens a ticket instead of a session; the session is
// created only by the request that captures the ticket with a right second proof, planned and
// written as pending inside the transaction that spends the proof, and made active after the
// commit is known. A lost answer, a failed activation or an unknown commit is finished by the
// same request repeated (continuation).

export type SecondStepMethod = 'totp' | 'recovery_code'

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

/** Thrown inside the transaction to roll it back with a decided answer. */
class Abort extends Error {
    constructor(
        readonly kind: 'wrong' | 'revoked' | 'used' | 'expired' | 'gone' | 'error',
        readonly error?: AppError,
    ) {
        super(kind)
        this.name = 'MfaAbort'
    }
}

const methodsOf = (account: { totp: unknown }): SecondStepMethod[] => {
    const methods: SecondStepMethod[] = []
    if (account.totp !== undefined) methods.push('totp')
    methods.push('recovery_code')
    return methods
}

/**
 * Р4: after the first factor. Answers null when the account has no second factor (the caller
 * signs in as before), or the second step it opened: a ticket and its cookie.
 */
export async function startSecondStepIfRequired(
    auth: Auth,
    browserSession: string | null,
    user: { id: bigint; sessionToken: string },
    origin: Exclude<LoginOrigin, { inherit: unknown }>,
    extras: { pendingOAuthLink?: PendingOAuthLink } = {},
): Promise<AppResult<SecondStepRequired | null>> {
    const account = await loadMfaFactors(user.id)
    if (account.totp === undefined && account.passkeys === 0) return Result.ok(null)
    if (browserSession === null) return Result.err(serviceUnavailable())
    const ticketId = newTicketId()
    const ticket: MfaTicket = {
        v: 1,
        state: 'open',
        userId: String(user.id),
        userTokenAtStart: user.sessionToken,
        binding: mfaBinding(browserSession),
        origin,
        firstFactor: origin.method === 'oauth' ? 'oauth' : 'pwd',
        ...(extras.pendingOAuthLink !== undefined
            ? { pendingOAuthLink: extras.pendingOAuthLink }
            : {}),
        failures: 0,
        reservations: [],
        settled: [],
    }
    try {
        await mfaTicketStore.create(ticketId, ticket, mfaConfig.ticketTtlSeconds)
    } catch (err) {
        logger.error({ err }, 'Second-step ticket not created')
        return Result.err(serviceUnavailable(err))
    }
    auth.setMfaTicketCookie(ticketId, mfaConfig.ticketTtlSeconds)
    return Result.ok({ status: 'mfa_required', methods: methodsOf(account) })
}

/** The session the second step creates (Р2, Р8). */
function plannedAuth(ticket: MfaTicket, method: SecondStepMethod, now: number): SessionAuthState {
    const at = new Date(now).toISOString()
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
                expiresAt: new Date(now + mfaConfig.recoveryWindowSeconds * 1000).toISOString(),
            },
        }
    }
    return {
        v: 1,
        amr: [first, 'otp'],
        aal: 2,
        authenticatedAt: at,
        verified: { [first]: at, otp: at },
    }
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

export interface SecondStepInput {
    method: SecondStepMethod
    code: string
}

export interface SecondStepDeps {
    now?: () => number
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
    const now = deps.now?.() ?? Date.now()
    const ticketId = context.auth.getMfaTicketCookie()
    const cookieSession = context.auth.getCookieSessionId()
    if (ticketId === undefined || ticketId === '' || cookieSession === undefined) {
        return Result.err(ticketInvalid())
    }
    const binding = mfaBinding(cookieSession)
    const reservationId = nanoid()
    const reservationTtlMs = mfaConfig.reservationTtlSeconds * 1000

    let reserved: ReserveOutcome
    try {
        reserved = await mfaTicketStore.reserve(
            ticketId,
            binding,
            reservationId,
            now,
            reservationTtlMs,
        )
    } catch (err) {
        return Result.err(serviceUnavailable(err))
    }
    if (reserved.kind === 'invalid') {
        context.auth.setMfaTicketCookie(null, 0)
        return Result.err(ticketInvalid())
    }
    if (reserved.kind === 'busy') return Result.err(ticketInvalid())
    if (reserved.kind === 'completing' || reserved.kind === 'activated') {
        return continueCompletion(context, ticketId, reserved.ticket, input, request, deps)
    }
    return attempt(context, ticketId, reserved.ticket, reservationId, input, request, deps, now)
}

async function attempt(
    context: SignInContext,
    ticketId: string,
    ticket: MfaTicket,
    reservationId: string,
    input: SecondStepInput,
    request: AuditRequest,
    deps: SecondStepDeps,
    now: number,
): Promise<AppResult<AuthSuccessPayload>> {
    const userId = BigInt(ticket.userId)
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

    const completionId = nanoid()
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

    try {
        await withTransaction(async (tx) => {
            const locked = await userRepository.lockById(userId, tx)
            if (locked?.sessionToken !== ticket.userTokenAtStart) {
                throw new Abort('revoked')
            }
            if (recovery) {
                if (!(await recoveryCodes.consume(userId, input.code, tx))) throw new Abort('wrong')
            } else {
                const verified = await totpService.verify(userId, input.code, {
                    now,
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
            const expectedUserToken = recovery ? nanoid() : locked.sessionToken
            const plan = context.auth.planLogin(
                ticket.userId,
                ticket.origin,
                plannedAuth(ticket, input.method, now),
                expectedUserToken,
            )
            progress.plan = plan
            const capture = await mfaTicketStore.capture(
                ticketId,
                reservationId,
                now,
                mfaConfig.reservationTtlSeconds * 1000,
                { completionId, xid, plan },
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
                case 'wrong': {
                    let settled = 'ok'
                    try {
                        settled = await mfaTicketStore.settle(ticketId, reservationId, 'failure')
                    } catch (settleErr) {
                        logger.warn({ err: settleErr }, 'Failure not counted on the ticket')
                    }
                    if (settled === 'deleted') context.auth.setMfaTicketCookie(null, 0)
                    return Result.err(invalidCode())
                }
                case 'revoked': {
                    await release()
                    // A recovery sign-in of a parallel attempt rotated the token: that attempt
                    // won, and its ticket stays for its continuation.
                    const current = await mfaTicketStore.read(ticketId).catch(() => null)
                    if (current !== null && current.state !== 'open') {
                        return Result.err(
                            unauthorized('Signed in already', MFA_REASONS.mfaTicketUsed),
                        )
                    }
                    await mfaTicketStore.delete(ticketId).catch(() => undefined)
                    context.auth.setMfaTicketCookie(null, 0)
                    return Result.err(sessionRevoked())
                }
                case 'used':
                    return Result.err(unauthorized('Signed in already', MFA_REASONS.mfaTicketUsed))
                case 'expired':
                    return Result.err(
                        unauthorized('Try the code again', MFA_REASONS.mfaAttemptExpired),
                    )
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
        // A known rollback: the proof was not spent; the same code can be sent again.
        logger.warn({ err }, 'Second step rolled back')
        if (progress.captured) {
            await discardPending(plan)
            await mfaTicketStore.reopen(ticketId, completionId).catch(() => false)
        } else {
            await release()
        }
        return Result.err(serviceUnavailable(err))
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
    userId: bigint,
    link: PendingOAuthLink,
    request: AuditRequest,
): Promise<RecordedAuditEvent[]> {
    const { proof, ...identity } = link
    try {
        await tx.transaction(async (savepoint) => {
            await oauthAccountRepository.create({ userId, ...identity }, savepoint)
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
    ticketId: string,
    ticket: MfaTicket,
    plan: LoginPlan,
    completionId: string,
    xid: string,
): Promise<AppResult<AuthSuccessPayload>> {
    const status = await readTransactionStatus(xid)
    if (status === 'committed') return activate(context, ticketId, ticket, plan, completionId)
    if (status === 'aborted') {
        await discardPending(plan)
        await mfaTicketStore.reopen(ticketId, completionId).catch(() => false)
        return Result.err(serviceUnavailable())
    }
    return Result.err(completionPending())
}

/** Р4: a repeat of the request after the ticket left `open`. */
async function continueCompletion(
    context: SignInContext,
    ticketId: string,
    ticket: MfaTicket,
    input: SecondStepInput,
    request: AuditRequest,
    deps: SecondStepDeps,
): Promise<AppResult<AuthSuccessPayload>> {
    const { plan, completionId, xid } = ticket
    if (plan === undefined || completionId === undefined) return Result.err(ticketInvalid())
    if (ticket.state === 'activated') {
        return activate(context, ticketId, ticket, plan, completionId)
    }
    if (xid === undefined) return Result.err(completionPending())
    const status = await readTransactionStatus(xid)
    if (status === 'committed') return activate(context, ticketId, ticket, plan, completionId)
    if (status === 'aborted') {
        // The confirmed attempt rolled back after all: the ticket opens again and this request,
        // which carries the code, is an attempt of its own.
        await discardPending(plan)
        const reopened = await mfaTicketStore.reopen(ticketId, completionId).catch(() => false)
        if (!reopened) return Result.err(completionPending())
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
    ticketId: string,
    ticket: MfaTicket,
    plan: LoginPlan,
    completionId: string,
): Promise<AppResult<AuthSuccessPayload>> {
    const userId = BigInt(plan.userId)
    let current: string | undefined
    try {
        current = await userRepository.findSessionToken(userId)
    } catch (err) {
        logger.warn({ err }, 'Session token not read before the activation')
        return Result.err(completionPending())
    }
    if (current !== plan.expectedUserToken) {
        await discardPending(plan)
        await mfaTicketStore.delete(ticketId).catch(() => undefined)
        context.auth.setMfaTicketCookie(null, 0)
        return Result.err(sessionRevoked())
    }
    const recoveryExpiry = plan.auth.recovery?.expiresAt
    if (recoveryExpiry !== undefined && Date.parse(recoveryExpiry) <= Date.now()) {
        await mfaTicketStore.delete(ticketId).catch(() => undefined)
        context.auth.setMfaTicketCookie(null, 0)
        return Result.err(ticketInvalid())
    }

    let outcome: 'activated' | 'already' | 'gone'
    try {
        outcome = await context.auth.activateLogin(
            plan,
            mfaTicketStore.keyOf(ticketId),
            completionId,
        )
    } catch (err) {
        logger.warn({ err }, 'Activation failed; the same request finishes it')
        return Result.err(completionPending())
    }
    if (outcome === 'gone') {
        context.auth.setMfaTicketCookie(null, 0)
        return Result.err(ticketInvalid())
    }

    if (outcome === 'activated') {
        // At most one attempt per completion: only the request that activated sends these.
        notifyNewSignIn(userId, plan.device, { mail: true })
        if (plan.auth.recovery !== undefined) {
            userNotificationService.security(userId, 'recovery_code_used')
            void endOtherSessions(ticket, plan)
        }
    }
    const user = await userRepository.findById(userId)
    if (user === undefined) return Result.err(sessionRevoked())
    return Result.ok(await authSuccessPayload(user, context.session))
}

/** Р8: the sessions and sockets of the token a recovery sign-in rotated. */
async function endOtherSessions(ticket: MfaTicket, plan: LoginPlan): Promise<void> {
    try {
        wsSessionRevocation.closeUserConnections(plan.userId, { exceptSessionId: plan.sessionId })
        await destroyAllSessions(ticket.userTokenAtStart)
    } catch (err) {
        logger.warn({ err }, 'Sessions of the rotated token not cleaned up; they are revoked')
    }
}

/** Р4: the browser came back with the new session: its ticket is not needed any more. */
export async function retireCompletedTicket(auth: Auth, completionId: string): Promise<void> {
    const ticketId = auth.getMfaTicketCookie()
    if (ticketId === undefined || ticketId === '') return
    await mfaTicketStore.retire(ticketId, completionId)
    auth.setMfaTicketCookie(null, 0)
}
