import { Result } from 'better-result'
import { validatePassword } from 'metautil'
import {
    MFA_REASONS,
    PROOF_METHOD_REF,
    stepUpProofsOf,
    withVerified,
    type ProofMethod,
    type SessionAuthState,
} from 'shared/mfa'

import type { AuthenticationResponse } from 'shared/schemas'

import { throttlePolicies } from '#config/throttle-policies.js'
import webauthnConfig from '#config/webauthn.js'
import {
    userRepository,
    webauthnCredentialRepository,
    type UserRow,
} from '#app/repositories/index.js'
import type { AuditRequest } from '#app/services/audit/audit-actor.js'
import { enforceThrottle } from '#app/services/auth/enforce-throttle.js'
import { resetAuthThrottle } from '#app/services/auth/auth-throttle-service.js'
import {
    badRequest,
    forbidden,
    notFound,
    rateLimited,
    sessionRevoked,
    type AppError,
    type AppResult,
} from '#app/services/shared/errors.js'
import type { Session } from '#vendor/types/types.js'
import logger from '#vendor/utils/logger.js'
import { loadMfaAccount, proofAccountOf } from './mfa-account.js'
import { totpService } from './totp-service.js'
import { recordCounterRegression } from './passkey-sign-in.js'
import {
    authenticationOptions,
    ceremonyBinding,
    fromBase64Url,
    verifyWebAuthnCeremony,
} from './webauthn-ceremony.js'

/** feat-246: the pending passkey step-up, in the data of the session that asked for it. */
export const PASSKEY_REAUTH_KEYS = {
    challenge: 'passkeyReauthChallenge',
    expiresAt: 'passkeyReauthExpiresAt',
} as const

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р3): a step-up records that this session proved a
// method now; the matrix (requireProof) decides which marks an action accepts. A password is
// recorded for an account with MFA too, but no row of the matrix accepts it there.

export interface StepUpRequest {
    userId: bigint
    session: Session
    presentedSessionToken: string | undefined
    now?: number
    /** For the audit event of a counter that went back (feat-246). */
    request?: AuditRequest
}

const passkeyRefused = (): AppError =>
    badRequest('The passkey was not accepted', MFA_REASONS.invalidCode)

const authOf = (session: Session): SessionAuthState | undefined => session.sessionInfo?.data.auth

async function readUser(request: StepUpRequest): Promise<AppResult<UserRow>> {
    const user = await userRepository.findById(request.userId)
    if (user === undefined) return Result.err(notFound('User', 'User not found'))
    if (
        request.presentedSessionToken === undefined ||
        user.sessionToken !== request.presentedSessionToken
    ) {
        return Result.err(sessionRevoked())
    }
    return Result.ok(user)
}

export const stepUpService = {
    /** The proofs this account can give (POST /auth/reauth/options). */
    async options(request: StepUpRequest): Promise<AppResult<{ proofs: ProofMethod[] }>> {
        const user = await readUser(request)
        if (Result.isError(user)) return Result.err(user.error)
        return Result.ok({
            proofs: stepUpProofsOf(proofAccountOf(await loadMfaAccount(user.value))),
        })
    },

    /**
     * feat-246 (Р6): the options of a passkey step-up, with the user's keys; the challenge stays in
     * this session (`reauth:<sessionId>`, Р5) until POST /auth/reauth spends it.
     */
    async passkeyOptions(request: StepUpRequest): Promise<AppResult<{ options: object }>> {
        if (authOf(request.session)?.recovery !== undefined) {
            return Result.err(
                forbidden('Finish recovering your account first', MFA_REASONS.recoverySession),
            )
        }
        const user = await readUser(request)
        if (Result.isError(user)) return Result.err(user.error)
        const keys = await webauthnCredentialRepository.listByUserId(user.value.id)
        if (keys.length === 0) {
            return Result.err(badRequest('This proof is not available', 'proof_unavailable'))
        }
        const options = await authenticationOptions(keys)
        const expiresAt = new Date(
            (request.now ?? Date.now()) + webauthnConfig.challengeTtlSeconds * 1000,
        ).toISOString()
        const stored = await request.session.updateSessionData({
            [PASSKEY_REAUTH_KEYS.challenge]: options.challenge,
            [PASSKEY_REAUTH_KEYS.expiresAt]: expiresAt,
        })
        if (stored === null) return Result.err(sessionRevoked())
        return Result.ok({ options })
    },

    async reauth(
        request: StepUpRequest,
        input: {
            proof: 'password' | 'totp' | 'webauthn'
            password?: string
            code?: string
            response?: AuthenticationResponse
        },
    ): Promise<AppResult<void>> {
        if (authOf(request.session)?.recovery !== undefined) {
            return Result.err(
                forbidden('Finish recovering your account first', MFA_REASONS.recoverySession),
            )
        }
        const userResult = await readUser(request)
        if (Result.isError(userResult)) return Result.err(userResult.error)
        const user = userResult.value
        const account = await loadMfaAccount(user)
        const available = stepUpProofsOf(proofAccountOf(account))
        // A password stays usable as a step-up of an account with MFA only where the matrix
        // takes it (it takes it nowhere), so offering it there would only mislead: refused.
        if (!available.includes(input.proof)) {
            return Result.err(badRequest('This proof is not available', 'proof_unavailable'))
        }

        if (input.proof === 'password') {
            if (input.password === undefined || user.password === null || user.password === '') {
                return Result.err(badRequest('Enter your password', 'current_password_required'))
            }
            // Spent before the check, from the per-user budget of change-password (feat-109).
            const throttle = await enforceThrottle(
                throttlePolicies.changePasswordUser,
                String(user.id),
                rateLimited('Too many password attempts. Please try again later.'),
            )
            if (Result.isError(throttle)) return Result.err(throttle.error)
            if (!(await validatePassword(input.password, user.password))) {
                return Result.err(
                    badRequest('Current password is incorrect', 'current_password_incorrect'),
                )
            }
            try {
                await resetAuthThrottle(throttlePolicies.changePasswordUser, String(user.id))
            } catch (err) {
                logger.warn({ err }, 'Step-up throttle reset failed')
            }
        } else if (input.proof === 'webauthn') {
            if (input.response === undefined) return Result.err(passkeyRefused())
            const checked = await checkPasskeyStepUp(request, user, input.response)
            if (Result.isError(checked)) return Result.err(checked.error)
        } else {
            if (input.code === undefined) {
                return Result.err(badRequest('Enter the code', MFA_REASONS.invalidCode))
            }
            const verified = await totpService.verify(user.id, input.code, {
                ...(request.now !== undefined ? { now: request.now } : {}),
            })
            if (Result.isError(verified)) return Result.err(verified.error)
        }

        const at = new Date(request.now ?? Date.now()).toISOString()
        const updated = await request.session.updateSessionAuth((current) =>
            withVerified(current, PROOF_METHOD_REF[input.proof], at),
        )
        if (updated === null) return Result.err(sessionRevoked())
        return Result.ok(undefined)
    },
}

/**
 * feat-246 (Р5, Р6): a passkey step-up. The challenge of this session is spent first, atomically
 * (consumeSessionData: of two answers one gets it), then the answer is checked as a `reauth`
 * ceremony with a key of this user, and the counter is recorded.
 */
async function checkPasskeyStepUp(
    request: StepUpRequest,
    user: UserRow,
    response: AuthenticationResponse,
): Promise<AppResult<void>> {
    const data = request.session.sessionInfo?.data
    const challenge = data?.[PASSKEY_REAUTH_KEYS.challenge]
    const expiresAt = data?.[PASSKEY_REAUTH_KEYS.expiresAt]
    if (typeof challenge !== 'string' || typeof expiresAt !== 'string') {
        return Result.err(passkeyRefused())
    }
    const consumed = await request.session.consumeSessionData(
        { [PASSKEY_REAUTH_KEYS.challenge]: challenge },
        Object.values(PASSKEY_REAUTH_KEYS),
    )
    if (consumed !== 'consumed') return Result.err(passkeyRefused())
    if (Date.parse(expiresAt) <= (request.now ?? Date.now())) return Result.err(passkeyRefused())

    const credential = await webauthnCredentialRepository.findByCredentialId(
        fromBase64Url(response.id),
    )
    if (credential === undefined) return Result.err(passkeyRefused())
    const binding = ceremonyBinding('reauth', request.session.sessionInfo?.id ?? '')
    const verified = await verifyWebAuthnCeremony({
        purpose: 'reauth',
        stored: { challenge, binding },
        expectedBinding: binding,
        response,
        credential,
        expectedUserId: user.id,
        expectedUserHandle: user.webauthnUserHandle,
    })
    if (!verified.ok || !('assertion' in verified)) {
        if (
            !verified.ok &&
            verified.failure === 'counter_regressed' &&
            request.request !== undefined
        ) {
            await recordCounterRegression(credential, 'reauth', request.request)
        }
        return Result.err(passkeyRefused())
    }
    const counted = await webauthnCredentialRepository.recordUse(
        credential.id,
        verified.assertion.newCounter,
    )
    if (counted !== 'advanced') {
        if (counted === 'regressed' && request.request !== undefined) {
            await recordCounterRegression(credential, 'reauth', request.request)
        }
        return Result.err(passkeyRefused())
    }
    return Result.ok(undefined)
}
