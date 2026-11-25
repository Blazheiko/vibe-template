import { Result } from 'better-result'
import { nanoid } from 'nanoid'
import { PRODUCT } from 'shared/product'
import {
    MFA_REASONS,
    stepUpProofsOf,
    withReplacementFactor,
    type AcceptedProof,
    type SessionAuthState,
    type StaffFactorMode,
} from 'shared/mfa'

import mfaConfig from '#config/mfa.js'
import { throttlePolicies } from '#config/throttle-policies.js'
import {
    totpFactorRepository,
    userRepository,
    withTransaction,
    type DbExecutor,
    type TotpFactorRow,
} from '#app/repositories/index.js'
import { auditService } from '#app/services/audit/audit-service.js'
import { withProof, withRole, type UserAuditActor } from '#app/services/audit/audit-actor.js'
import { enforceThrottle } from '#app/services/auth/enforce-throttle.js'
import { signInCapability } from '#app/services/auth/sign-in-methods-service.js'
import {
    badRequest,
    conflict,
    notFound,
    rateLimited,
    serviceUnavailable,
    sessionRevoked,
    type AppError,
    type AppResult,
} from '#app/services/shared/errors.js'
import type { Session } from '#vendor/types/types.js'
import logger from '#vendor/utils/logger.js'
import {
    hasRecoveryContactOf,
    loadMfaAccount,
    mfaEnabledOf,
    proofAccountOf,
    type MfaAccount,
} from './mfa-account.js'
import { mfaSecretBox, totpSecretOwner } from './mfa-secret-box.js'
import { retirePendingContactLinks } from './contact-links.js'
import { announceMfaChange } from './mfa-notice.js'
import { recoveryCodes } from './recovery-codes.js'
import { isAcceptedProof, keptProofRefusal, requireProof } from './require-proof.js'
import { staffFactorFor, staffFactorLossError } from './staff-policy.js'
import {
    base32Decode,
    base32Encode,
    generateTotpSecret,
    matchTotpStep,
    otpauthUri,
} from './totp.js'
import type { UserId } from '#app/domain/ids.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р7, Р8): the TOTP factor of the signed-in user.

/** The pending setup, in the data of the session that started it (not shared with others). */
export const TOTP_ENROLLMENT_KEY = 'totpEnrollment'
/**
 * feat-258 (docs/plan/mfa-review-fixes-7-plan.md, 8.4): the id of the stored setup as a string of
 * its own, so a refused setup is removed for its enrollment id only, atomically
 * (consumeSessionData compares strings): a newer setup of another tab stays.
 */
export const TOTP_ENROLLMENT_ID_KEY = 'totpEnrollmentId'

interface TotpEnrollment {
    enrollmentId: string
    /** base32 of the secret; the record lives in Redis for at most the setup's lifetime. */
    secret: string
    expiresAt: string
    /**
     * Р14: the proof `requireProof` accepted at the setup, recorded by the confirmation. Absent
     * in a setup stored before it was kept: such a setup is started again.
     */
    proof?: AcceptedProof
}

const isEnrollment = (value: unknown): value is TotpEnrollment =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TotpEnrollment).enrollmentId === 'string' &&
    typeof (value as TotpEnrollment).secret === 'string' &&
    typeof (value as TotpEnrollment).expiresAt === 'string'

export interface TotpRequest {
    userId: UserId
    session: Session
    presentedSessionToken: string | undefined
    actor: UserAuditActor
    now?: number
}

export interface MfaStatus {
    totp: { enabled: boolean; createdAt: string | null }
    passkeys: number
    recoveryCodesRemaining: number
    recoveryContact: boolean
    stepUpProofs: ('password' | 'totp' | 'webauthn')[]
    recovery: { expiresAt: string; replaced: boolean } | null
    /** feat-248: the factor a staff role needs here; null without one. */
    staffFactor: StaffFactorMode | null
}

const authOf = (session: Session): SessionAuthState | undefined => session.sessionInfo?.data.auth

const tooManyCodes = (): AppError => rateLimited('Too many codes. Please try again later.')

async function readAccount(userId: UserId): Promise<AppResult<MfaAccount>> {
    const user = await userRepository.findById(userId)
    if (user === undefined) return Result.err(notFound('User', 'User not found'))
    return Result.ok(await loadMfaAccount(user))
}

/** The secret of a stored version, or null when it does not open (lost key, tampering). */
export function openTotpSecret(factor: TotpFactorRow): Buffer | null {
    const box = mfaSecretBox()
    if (box === null) return null
    try {
        return box.open(
            { ciphertext: factor.secretCiphertext, keyId: factor.keyId },
            totpSecretOwner(factor.userId),
        )
    } catch (err) {
        logger.error({ err, userId: String(factor.userId) }, 'TOTP secret does not open')
        return null
    }
}

export const totpService = {
    async status(userId: UserId, session: Session): Promise<AppResult<MfaStatus>> {
        const user = await userRepository.findById(userId)
        if (user === undefined) return Result.err(notFound('User', 'User not found'))
        const account = await loadMfaAccount(user)
        const { totp, passkeys, recoveryCodesRemaining, hasRecoveryContact } = account
        const recovery = authOf(session)?.recovery
        return Result.ok({
            totp: {
                enabled: totp !== undefined,
                createdAt: totp?.confirmedAt.toISOString() ?? null,
            },
            passkeys,
            recoveryCodesRemaining,
            recoveryContact: hasRecoveryContact,
            stepUpProofs: stepUpProofsOf(proofAccountOf(account)),
            recovery:
                recovery === undefined
                    ? null
                    : {
                          expiresAt: recovery.expiresAt,
                          replaced: recovery.replacementFactor !== undefined,
                      },
            staffFactor: staffFactorFor(user.role),
        })
    },

    /** Rows 1–2 of the matrix: a new secret, kept in this session until it is confirmed. */
    async setup(
        request: TotpRequest,
    ): Promise<AppResult<{ enrollmentId: string; secret: string; otpauthUri: string }>> {
        const user = await userRepository.findById(request.userId)
        if (user === undefined) return Result.err(notFound('User', 'User not found'))
        const account = await loadMfaAccount(user)
        const proof = requireProof({
            action: 'mfa.add_factor',
            account,
            auth: authOf(request.session),
            ...(request.now !== undefined ? { now: request.now } : {}),
        })
        if (Result.isError(proof)) return Result.err(proof.error)
        // Р12: an account with MFA always has a channel through which a password is set again.
        if (!mfaEnabledOf(account) && !account.hasRecoveryContact) {
            return Result.err(
                conflict(
                    'Verify your email (or phone) before turning on two-step sign-in',
                    MFA_REASONS.recoveryContactRequired,
                ),
            )
        }
        if (mfaSecretBox() === null) return Result.err(serviceUnavailable())

        const secret = generateTotpSecret()
        const enrollment: TotpEnrollment = {
            enrollmentId: nanoid(24),
            secret: base32Encode(secret),
            expiresAt: new Date(
                (request.now ?? Date.now()) + mfaConfig.totpEnrollmentTtlSeconds * 1000,
            ).toISOString(),
            proof: proof.value,
        }
        const stored = await request.session.updateSessionData({
            [TOTP_ENROLLMENT_KEY]: enrollment,
            [TOTP_ENROLLMENT_ID_KEY]: enrollment.enrollmentId,
        })
        if (stored === null) return Result.err(sessionRevoked())
        const accountName = user.email ?? user.phone ?? user.name
        return Result.ok({
            enrollmentId: enrollment.enrollmentId,
            secret: enrollment.secret,
            otpauthUri: otpauthUri(secret, PRODUCT.name, accountName),
        })
    },

    /**
     * Р7: confirms the setup with a code of the new secret. Idempotent by `enrollmentId`: a
     * repeat after a commit whose session write failed finishes it without a second version.
     */
    async confirm(
        request: TotpRequest,
        input: { enrollmentId: string; code: string },
    ): Promise<AppResult<{ recoveryCodes: string[] | null }>> {
        const { userId, session } = request
        const now = request.now ?? Date.now()
        const data = session.sessionInfo?.data
        const pending = data?.[TOTP_ENROLLMENT_KEY]
        // feat-259 (docs/plan/mfa-review-fixes-7-plan.md, 9.2): a setup not written yet is taken
        // only with its id key too, so a refusal can always remove it for that id; one stored
        // without it (before feat-258) is set up again. A committed enrollment is finished below
        // whatever the session holds.
        const held =
            isEnrollment(pending) && pending.enrollmentId === input.enrollmentId ? pending : null
        const enrollment =
            held !== null && data?.[TOTP_ENROLLMENT_ID_KEY] === held.enrollmentId ? held : null

        // A repeat of a confirmation that committed: finish the session write only (the setup this
        // session holds for it, with or without its id key).
        const committed = await totpFactorRepository.findByEnrollment(userId, input.enrollmentId)
        if (committed !== undefined) {
            if (held === null) return Result.ok({ recoveryCodes: null })
            const finished = await finishInSession(session, committed, now)
            if (Result.isError(finished)) return Result.err(finished.error)
            return Result.ok({ recoveryCodes: null })
        }

        // Р14: the audit records the proof the setup accepted; a setup stored without it is not
        // guessed at (the marks and the factors may have changed since), it starts again.
        if (
            enrollment === null ||
            Date.parse(enrollment.expiresAt) <= now ||
            !isAcceptedProof(enrollment.proof)
        ) {
            return Result.err(badRequest('Start the setup again', MFA_REASONS.enrollmentNotFound))
        }
        const setupProof = enrollment.proof

        const throttle = await enforceThrottle(
            throttlePolicies.mfaVerifyUser,
            String(userId),
            tooManyCodes(),
        )
        if (Result.isError(throttle)) return Result.err(throttle.error)

        const secret = base32Decode(enrollment.secret)
        const step = matchTotpStep(secret, input.code, now)
        if (step === null) return Result.err(badRequest('Invalid code', MFA_REASONS.invalidCode))

        const box = mfaSecretBox()
        if (box === null) return Result.err(serviceUnavailable())
        const sealed = box.seal(secret, totpSecretOwner(userId))
        const { actor } = request

        // Set inside the transaction callback, read after it (an object: not narrowed to false).
        const refused = { keptProof: false }
        const result = await withTransaction(async (tx) => {
            const locked = await userRepository.lockById(userId, tx)
            if (locked === undefined) return Result.err(notFound('User', 'User not found'))
            if (locked.sessionToken !== request.presentedSessionToken) {
                return Result.err(sessionRevoked())
            }
            // Under the lock: a parallel confirmation of the same setup got here first.
            const again = await totpFactorRepository.findByEnrollment(
                userId,
                input.enrollmentId,
                tx,
            )
            if (again !== undefined) {
                return Result.ok({ factor: again, replaced: false, codes: null, events: [] })
            }
            const account = await loadMfaAccount(locked, tx)
            // feat-256 (item 3): the proof the setup kept, against the factors as they are now
            // (another session may have turned MFA on since). feat-258 (8.4): a refused setup is
            // removed after the transaction, so it cannot pass later when the factors change back.
            const refusal = keptProofRefusal({
                action: 'mfa.add_factor',
                account,
                auth: authOf(session),
                proof: setupProof,
                now: request.now ?? Date.now(),
            })
            if (refusal !== null) {
                refused.keptProof = true
                return Result.err(refusal)
            }
            if (!mfaEnabledOf(account) && !hasRecoveryContactOf(locked)) {
                return Result.err(
                    conflict(
                        'Verify your email (or phone) before turning on two-step sign-in',
                        MFA_REASONS.recoveryContactRequired,
                    ),
                )
            }
            const { created, replaced } = await totpFactorRepository.replace(
                {
                    userId,
                    enrollmentId: input.enrollmentId,
                    secretCiphertext: sealed.ciphertext,
                    keyId: sealed.keyId,
                    lastUsedStep: step,
                    confirmedAt: new Date(now),
                },
                tx,
            )
            await retirePendingContactLinks(userId, tx)
            const codes =
                account.recoveryCodesRemaining === 0 ? await recoveryCodes.issue(userId, tx) : null
            // Р14: the proof the setup accepted (the step-up of its first step), as it was then.
            const proven = withProof(actor, setupProof)
            const stamp = await auditService.stamp(tx)
            const events = await auditService.record(tx, stamp, withRole(proven, locked.role), [
                replaced
                    ? {
                          action: 'auth.mfa.totp.replaced',
                          targetId: String(userId),
                          targetUserId: userId,
                          input: {},
                      }
                    : {
                          action: 'auth.mfa.totp.enabled',
                          targetId: String(userId),
                          targetUserId: userId,
                          input: { recoveryCodesIssued: codes !== null },
                      },
            ])
            return Result.ok({ factor: created, replaced, codes, events })
        })
        if (Result.isError(result)) {
            if (refused.keptProof) {
                await session
                    .consumeSessionData({ [TOTP_ENROLLMENT_ID_KEY]: input.enrollmentId }, [
                        TOTP_ENROLLMENT_KEY,
                        TOTP_ENROLLMENT_ID_KEY,
                    ])
                    .catch((err: unknown) => {
                        logger.warn({ err }, 'Refused TOTP setup not removed; it expires by itself')
                    })
            }
            return Result.err(result.error)
        }
        const outcome = result.value
        auditService.logCommitted(actor.logger, outcome.events)
        if (outcome.events.length > 0) {
            announceMfaChange(userId, outcome.replaced ? 'replaced' : 'enabled')
        }

        const finished = await finishInSession(session, outcome.factor, now)
        if (Result.isError(finished)) return Result.err(finished.error)
        return Result.ok({ recoveryCodes: outcome.codes })
    },

    /**
     * Р4, Р7: checks a code against the version stored now and spends its step for that version
     * only. Throttled per user before the check. Answers the version that matched.
     */
    async verify(
        userId: UserId,
        code: string,
        options: { now?: number; executor?: DbExecutor; throttle?: boolean } = {},
    ): Promise<AppResult<{ factorId: bigint }>> {
        if (options.throttle !== false) {
            const throttle = await enforceThrottle(
                throttlePolicies.mfaVerifyUser,
                String(userId),
                tooManyCodes(),
            )
            if (Result.isError(throttle)) return Result.err(throttle.error)
        }
        const factor = await totpFactorRepository.findByUserId(userId, options.executor)
        if (factor === undefined) {
            return Result.err(badRequest('Invalid code', MFA_REASONS.invalidCode))
        }
        const secret = openTotpSecret(factor)
        if (secret === null) return Result.err(serviceUnavailable())
        const step = matchTotpStep(secret, code, options.now ?? Date.now())
        if (step === null) return Result.err(badRequest('Invalid code', MFA_REASONS.invalidCode))
        const spent = await totpFactorRepository.consumeStep(
            userId,
            factor.id,
            step,
            options.executor,
        )
        if (!spent) return Result.err(badRequest('Invalid code', MFA_REASONS.invalidCode))
        return Result.ok({ factorId: factor.id })
    },

    /** Row 3: removes the TOTP factor; the last factor takes the recovery codes with it. */
    async disable(request: TotpRequest): Promise<AppResult<{ mfaDisabled: boolean }>> {
        const { userId, session } = request
        const account = await readAccount(userId)
        if (Result.isError(account)) return Result.err(account.error)
        if (account.value.totp === undefined) {
            return Result.err(notFound('TotpFactor', 'Two-step sign-in is not on'))
        }
        const auth = authOf(session)
        const proof = requireProof({
            action: 'mfa.remove_factor',
            account: account.value,
            auth,
            ...(request.now !== undefined ? { now: request.now } : {}),
        })
        if (Result.isError(proof)) return Result.err(proof.error)
        // R+: the replacement installed in this recovery session stays.
        if (auth?.recovery?.replacementFactor?.kind === 'totp') {
            return Result.err(
                conflict('The factor set up in this recovery stays', MFA_REASONS.recoverySession),
            )
        }
        const actor = withProof(request.actor, proof.value)
        const result = await withTransaction(async (tx) => {
            const locked = await userRepository.lockById(userId, tx)
            if (locked === undefined) return Result.err(notFound('User', 'User not found'))
            if (locked.sessionToken !== request.presentedSessionToken) {
                return Result.err(sessionRevoked())
            }
            const current = await loadMfaAccount(locked, tx)
            if (current.totp === undefined) {
                return Result.err(notFound('TotpFactor', 'Two-step sign-in is not on'))
            }
            // feat-248 (Р12): a staff account keeps the factor its role needs (in the passkey
            // mode TOTP may go while a passkey stays).
            const after = await signInCapability(locked, tx, { removeTotp: true })
            const staffLoss = staffFactorLossError(locked.role, after)
            if (staffLoss !== null) return Result.err(staffLoss)
            await totpFactorRepository.deleteByUserId(userId, tx)
            await retirePendingContactLinks(userId, tx)
            const mfaDisabled = current.passkeys === 0
            if (mfaDisabled) await recoveryCodes.removeAll(userId, tx)
            const stamp = await auditService.stamp(tx)
            const events = await auditService.record(tx, stamp, withRole(actor, locked.role), [
                {
                    action: 'auth.mfa.totp.disabled',
                    targetId: String(userId),
                    targetUserId: userId,
                    input: { mfaDisabled },
                },
            ])
            return Result.ok({ mfaDisabled, events })
        })
        if (Result.isError(result)) return Result.err(result.error)
        auditService.logCommitted(actor.logger, result.value.events)
        announceMfaChange(userId, 'disabled')
        return Result.ok({ mfaDisabled: result.value.mfaDisabled })
    },

    /** Row 5: a new batch of recovery codes; the previous one stops working. */
    async regenerateRecoveryCodes(
        request: TotpRequest,
    ): Promise<AppResult<{ recoveryCodes: string[] }>> {
        const { userId, session } = request
        const account = await readAccount(userId)
        if (Result.isError(account)) return Result.err(account.error)
        const auth = authOf(session)
        const proof = requireProof({
            action: 'mfa.regenerate_codes',
            account: account.value,
            auth,
            ...(request.now !== undefined ? { now: request.now } : {}),
        })
        if (Result.isError(proof)) return Result.err(proof.error)
        const actor = withProof(request.actor, proof.value)
        const result = await withTransaction(async (tx) => {
            const locked = await userRepository.lockById(userId, tx)
            if (locked === undefined) return Result.err(notFound('User', 'User not found'))
            if (locked.sessionToken !== request.presentedSessionToken) {
                return Result.err(sessionRevoked())
            }
            const current = await loadMfaAccount(locked, tx)
            if (!mfaEnabledOf(current)) {
                return Result.err(
                    conflict('Turn on two-step sign-in first', MFA_REASONS.mfaRequired),
                )
            }
            const codes = await recoveryCodes.issue(userId, tx)
            const stamp = await auditService.stamp(tx)
            const events = await auditService.record(tx, stamp, withRole(actor, locked.role), [
                {
                    action: 'auth.mfa.recovery_codes.regenerated',
                    targetId: String(userId),
                    targetUserId: userId,
                    input: { count: codes.length },
                },
            ])
            return Result.ok({ codes, events })
        })
        if (Result.isError(result)) return Result.err(result.error)
        auditService.logCommitted(actor.logger, result.value.events)
        announceMfaChange(userId, 'recovery_codes_regenerated')
        return Result.ok({ recoveryCodes: result.value.codes })
    },
}

/**
 * Р7 step 4: one write of the session drops the consumed setup and, in a recovery session, records
 * the new version as the replacement (R+).
 */
async function finishInSession(
    session: Session,
    factor: TotpFactorRow,
    now: number,
): Promise<AppResult<void>> {
    const updated = await session.updateSessionAuth(
        (current) =>
            current.recovery === undefined
                ? current
                : withReplacementFactor(current, {
                      kind: 'totp',
                      id: String(factor.id),
                      at: new Date(now).toISOString(),
                  }),
        { removeKeys: [TOTP_ENROLLMENT_KEY, TOTP_ENROLLMENT_ID_KEY] },
    )
    if (updated === null) return Result.err(sessionRevoked())
    return Result.ok(undefined)
}
