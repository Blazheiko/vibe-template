import { Result } from 'better-result'
import { nanoid } from 'nanoid'
import { MFA_REASONS, withReplacementFactor, type SessionAuthState } from 'shared/mfa'
import type { RegistrationResponse } from 'shared/schemas'

import webauthnConfig from '#config/webauthn.js'
import {
    userRepository,
    webauthnCredentialRepository,
    withTransaction,
    type WebAuthnCredentialRow,
} from '#app/repositories/index.js'
import { auditService } from '#app/services/audit/audit-service.js'
import { withProof, withRole, type UserAuditActor } from '#app/services/audit/audit-actor.js'
import { signInCapability } from '#app/services/auth/sign-in-methods-service.js'
import {
    badRequest,
    conflict,
    notFound,
    sessionRevoked,
    type AppError,
    type AppResult,
} from '#app/services/shared/errors.js'
import type { Session } from '#vendor/types/types.js'
import { isUniqueViolation } from '#app/repositories/db-errors.js'
import { retirePendingContactLinks } from './contact-links.js'
import { hasRecoveryContactOf, loadMfaAccount, mfaEnabledOf } from './mfa-account.js'
import { announceMfaChange } from './mfa-notice.js'
import { recoveryCodes } from './recovery-codes.js'
import { auditProofOf, requireProof } from './require-proof.js'
import {
    ceremonyBinding,
    fromBase64Url,
    newUserHandle,
    registrationOptions,
    verifyWebAuthnCeremony,
} from './webauthn-ceremony.js'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р3 rows 1–3, Р6, Р12): the passkeys of the signed-in
// user. A registration is two requests: the options put a challenge and an enrollment id into the
// data of this session; the answer is checked and stored, idempotently by the enrollment id (a
// repeat after the commit returns the same key and only finishes the session write).

/** The pending registration, in the data of the session that asked for the options. */
export const PASSKEY_REGISTRATION_KEYS = {
    challenge: 'passkeyRegChallenge',
    enrollment: 'passkeyRegEnrollment',
    expiresAt: 'passkeyRegExpiresAt',
} as const
const REGISTRATION_KEYS = Object.values(PASSKEY_REGISTRATION_KEYS)

export interface PasskeyRequest {
    userId: bigint
    session: Session
    presentedSessionToken: string | undefined
    actor: UserAuditActor
    now?: number
}

export interface PasskeyView {
    id: string
    name: string
    deviceType: string
    backedUp: boolean
    createdAt: string
    lastUsedAt: string | null
}

export const passkeyView = (row: WebAuthnCredentialRow): PasskeyView => ({
    id: String(row.id),
    name: row.name,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
})

const authOf = (session: Session): SessionAuthState | undefined => session.sessionInfo?.data.auth

const sessionIdOf = (session: Session): string => session.sessionInfo?.id ?? ''

const contactRequired = (): AppError =>
    conflict(
        'Verify your email (or phone) before turning on two-step sign-in',
        MFA_REASONS.recoveryContactRequired,
    )

const limitReached = (): AppError =>
    conflict(
        `An account has at most ${String(webauthnConfig.maxPasskeysPerUser)} passkeys`,
        MFA_REASONS.passkeyLimit,
    )

const defaultName = (response: RegistrationResponse): string =>
    response.authenticatorAttachment === 'cross-platform' ? 'Security key' : 'Passkey'

const proofTime = (request: PasskeyRequest): { now?: number } =>
    request.now !== undefined ? { now: request.now } : {}

interface PendingRegistration {
    challenge: string
    enrollmentId: string
    expiresAt: string
}

function pendingOf(session: Session): PendingRegistration | null {
    const data = session.sessionInfo?.data
    const challenge = data?.[PASSKEY_REGISTRATION_KEYS.challenge]
    const enrollmentId = data?.[PASSKEY_REGISTRATION_KEYS.enrollment]
    const expiresAt = data?.[PASSKEY_REGISTRATION_KEYS.expiresAt]
    if (
        typeof challenge !== 'string' ||
        typeof enrollmentId !== 'string' ||
        typeof expiresAt !== 'string'
    ) {
        return null
    }
    return { challenge, enrollmentId, expiresAt }
}

export const passkeyService = {
    async list(userId: bigint): Promise<AppResult<PasskeyView[]>> {
        const rows = await webauthnCredentialRepository.listByUserId(userId)
        return Result.ok(rows.map(passkeyView))
    },

    /** Rows 1–2 of the matrix: the options of a new passkey, the challenge kept in this session. */
    async registerOptions(
        request: PasskeyRequest,
    ): Promise<AppResult<{ enrollmentId: string; options: object }>> {
        const user = await userRepository.findById(request.userId)
        if (user === undefined) return Result.err(notFound('User', 'User not found'))
        const account = await loadMfaAccount(user)
        const proof = requireProof({
            action: 'mfa.add_factor',
            account,
            auth: authOf(request.session),
            ...proofTime(request),
        })
        if (Result.isError(proof)) return Result.err(proof.error)
        // Р12: an account with MFA always has a channel through which a password is set again.
        if (!mfaEnabledOf(account) && !account.hasRecoveryContact) {
            return Result.err(contactRequired())
        }
        if (account.passkeys >= webauthnConfig.maxPasskeysPerUser) {
            return Result.err(limitReached())
        }

        const handle = await withTransaction((tx) =>
            webauthnCredentialRepository.ensureUserHandle(user.id, newUserHandle(), tx),
        )
        const existing = await webauthnCredentialRepository.listByUserId(user.id)
        const accountName = user.email ?? user.phone ?? user.name
        const options = await registrationOptions({
            userHandle: handle,
            userName: accountName,
            displayName: user.name,
            exclude: existing,
        })
        const enrollmentId = nanoid(24)
        const expiresAt = new Date(
            (request.now ?? Date.now()) + webauthnConfig.challengeTtlSeconds * 1000,
        ).toISOString()
        const stored = await request.session.updateSessionData({
            [PASSKEY_REGISTRATION_KEYS.challenge]: options.challenge,
            [PASSKEY_REGISTRATION_KEYS.enrollment]: enrollmentId,
            [PASSKEY_REGISTRATION_KEYS.expiresAt]: expiresAt,
        })
        if (stored === null) return Result.err(sessionRevoked())
        return Result.ok({ enrollmentId, options })
    },

    /**
     * Р6: stores the key the authenticator made for the pending options. Idempotent by the
     * enrollment id: the same answer after a commit (a lost reply, a failed session write)
     * finishes it without a second key; another key for a finished enrollment is refused.
     */
    async register(
        request: PasskeyRequest,
        input: { enrollmentId: string; name?: string; response: RegistrationResponse },
    ): Promise<AppResult<{ passkey: PasskeyView; recoveryCodes: string[] | null }>> {
        const { userId, session } = request
        const now = request.now ?? Date.now()
        const answered = fromBase64Url(input.response.id)
        const pending = pendingOf(session)
        const current = pending?.enrollmentId === input.enrollmentId ? pending : null

        const committed = await webauthnCredentialRepository.findByEnrollment(
            userId,
            input.enrollmentId,
        )
        if (committed !== undefined) {
            if (!committed.credentialId.equals(answered)) {
                return Result.err(
                    conflict('This registration was finished already', MFA_REASONS.enrollmentUsed),
                )
            }
            if (current !== null) {
                const finished = await finishInSession(session, committed, now)
                if (Result.isError(finished)) return Result.err(finished.error)
            }
            return Result.ok({ passkey: passkeyView(committed), recoveryCodes: null })
        }

        if (current === null || Date.parse(current.expiresAt) <= now) {
            return Result.err(
                badRequest('Start adding the passkey again', MFA_REASONS.enrollmentNotFound),
            )
        }

        const verified = await verifyWebAuthnCeremony({
            purpose: 'register',
            stored: {
                challenge: current.challenge,
                binding: ceremonyBinding('register', sessionIdOf(session)),
            },
            expectedBinding: ceremonyBinding('register', sessionIdOf(session)),
            response: input.response,
        })
        if (!verified.ok || !('registration' in verified)) {
            return Result.err(badRequest('The passkey was not accepted', MFA_REASONS.invalidCode))
        }
        const key = verified.registration
        const name = (input.name ?? '').trim() === '' ? defaultName(input.response) : input.name
        const actor = withProof(request.actor, auditProofOf(authOf(session)))

        const result = await withTransaction(async (tx) => {
            const locked = await userRepository.lockById(userId, tx)
            if (locked === undefined) return Result.err(notFound('User', 'User not found'))
            if (locked.sessionToken !== request.presentedSessionToken) {
                return Result.err(sessionRevoked())
            }
            // Under the lock: a parallel request of the same registration got here first.
            const again = await webauthnCredentialRepository.findByEnrollment(
                userId,
                input.enrollmentId,
                tx,
            )
            if (again !== undefined) {
                return again.credentialId.equals(key.credentialId)
                    ? Result.ok({ row: again, codes: null, events: [] })
                    : Result.err(
                          conflict(
                              'This registration was finished already',
                              MFA_REASONS.enrollmentUsed,
                          ),
                      )
            }
            const account = await loadMfaAccount(locked, tx)
            if (!mfaEnabledOf(account) && !hasRecoveryContactOf(locked)) {
                return Result.err(contactRequired())
            }
            if (account.passkeys >= webauthnConfig.maxPasskeysPerUser) {
                return Result.err(limitReached())
            }
            if (
                (await webauthnCredentialRepository.findByCredentialId(key.credentialId, tx)) !==
                undefined
            ) {
                return Result.err(
                    conflict('This passkey is registered already', MFA_REASONS.passkeyExists),
                )
            }
            await webauthnCredentialRepository.ensureUserHandle(userId, newUserHandle(), tx)
            const row = await webauthnCredentialRepository.insert(
                { userId, ...key, name: name ?? 'Passkey', enrollmentId: input.enrollmentId },
                tx,
            )
            await retirePendingContactLinks(userId, tx)
            const codes =
                account.recoveryCodesRemaining === 0 ? await recoveryCodes.issue(userId, tx) : null
            const stamp = await auditService.stamp(tx)
            const events = await auditService.record(tx, stamp, withRole(actor, locked.role), [
                {
                    action: 'auth.passkey.added',
                    targetId: String(userId),
                    targetUserId: userId,
                    input: { recoveryCodesIssued: codes !== null },
                },
            ])
            return Result.ok({ row, codes, events })
        }).catch((err: unknown) => {
            // Another account registered the same authenticator key in between.
            if (isUniqueViolation(err)) {
                return Result.err(
                    conflict('This passkey is registered already', MFA_REASONS.passkeyExists),
                )
            }
            throw err
        })
        if (Result.isError(result)) return Result.err(result.error)
        const { row, codes, events } = result.value
        auditService.logCommitted(actor.logger, events)
        if (events.length > 0) announceMfaChange(userId, 'passkey_added')

        const finished = await finishInSession(session, row, now)
        if (Result.isError(finished)) return Result.err(finished.error)
        return Result.ok({ passkey: passkeyView(row), recoveryCodes: codes })
    },

    async rename(userId: bigint, id: bigint, name: string): Promise<AppResult<PasskeyView>> {
        const renamed = await webauthnCredentialRepository.rename(id, userId, name.trim())
        if (!renamed) return Result.err(notFound('Passkey', 'Passkey not found'))
        const rows = await webauthnCredentialRepository.listByUserId(userId)
        const row = rows.find((item) => item.id === id)
        if (row === undefined) return Result.err(notFound('Passkey', 'Passkey not found'))
        return Result.ok(passkeyView(row))
    },

    /** Row 3: removes a passkey; the last factor takes the recovery codes with it (Р12). */
    async remove(
        request: PasskeyRequest,
        id: bigint,
    ): Promise<AppResult<{ mfaDisabled: boolean }>> {
        const { userId, session } = request
        const user = await userRepository.findById(userId)
        if (user === undefined) return Result.err(notFound('User', 'User not found'))
        const account = await loadMfaAccount(user)
        const auth = authOf(session)
        const proof = requireProof({
            action: 'mfa.remove_factor',
            account,
            auth,
            ...proofTime(request),
        })
        if (Result.isError(proof)) return Result.err(proof.error)
        // R+: the replacement installed in this recovery session stays.
        const replacement = auth?.recovery?.replacementFactor
        if (replacement?.kind === 'webauthn' && replacement.id === String(id)) {
            return Result.err(
                conflict('The passkey added in this recovery stays', MFA_REASONS.recoverySession),
            )
        }
        const actor = withProof(request.actor, auditProofOf(auth))
        const result = await withTransaction(async (tx) => {
            const locked = await userRepository.lockById(userId, tx)
            if (locked === undefined) return Result.err(notFound('User', 'User not found'))
            if (locked.sessionToken !== request.presentedSessionToken) {
                return Result.err(sessionRevoked())
            }
            const keys = await webauthnCredentialRepository.listByUserId(userId, tx)
            if (!keys.some((key) => key.id === id)) {
                return Result.err(notFound('Passkey', 'Passkey not found'))
            }
            // Р12: a passkey signs in on its own; the last way in stays.
            const capability = await signInCapability(locked, tx, { removePasskey: true })
            if (!capability.canSignIn) {
                return Result.err(
                    conflict(
                        'This is the only way to sign in to the account',
                        MFA_REASONS.lastSignInMethod,
                    ),
                )
            }
            const current = await loadMfaAccount(locked, tx)
            await webauthnCredentialRepository.deleteOne(id, userId, tx)
            await retirePendingContactLinks(userId, tx)
            const mfaDisabled = current.totp === undefined && current.passkeys <= 1
            if (mfaDisabled) await recoveryCodes.removeAll(userId, tx)
            const stamp = await auditService.stamp(tx)
            const events = await auditService.record(tx, stamp, withRole(actor, locked.role), [
                {
                    action: 'auth.passkey.removed',
                    targetId: String(userId),
                    targetUserId: userId,
                    input: { mfaDisabled },
                },
            ])
            return Result.ok({ mfaDisabled, events })
        })
        if (Result.isError(result)) return Result.err(result.error)
        auditService.logCommitted(actor.logger, result.value.events)
        announceMfaChange(userId, 'passkey_removed')
        return Result.ok({ mfaDisabled: result.value.mfaDisabled })
    },
}

/**
 * One write of the session drops the consumed registration and, in a recovery session, records
 * the new key as the replacement (R+).
 */
async function finishInSession(
    session: Session,
    row: WebAuthnCredentialRow,
    now: number,
): Promise<AppResult<void>> {
    const updated = await session.updateSessionAuth(
        (current) =>
            current.recovery === undefined
                ? current
                : withReplacementFactor(current, {
                      kind: 'webauthn',
                      id: String(row.id),
                      at: new Date(now).toISOString(),
                  }),
        { removeKeys: REGISTRATION_KEYS },
    )
    if (updated === null) return Result.err(sessionRevoked())
    return Result.ok(undefined)
}
