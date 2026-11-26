import { Result } from 'better-result'
import { toEntityId } from '#app/domain/ids.js'
import type { AuthenticationResponse } from 'shared/schemas'

import { throttlePolicies } from '#config/throttle-policies.js'
import {
    userRepository,
    webauthnCredentialRepository,
    withTransaction,
    type WebAuthnCredentialRow,
} from '#app/repositories/index.js'
import { auditService } from '#app/services/audit/audit-service.js'
import { proofHolderOf, type AuditRequest } from '#app/services/audit/audit-actor.js'
import { authSuccessPayload, type AuthSuccessPayload } from '#app/services/auth/auth-success.js'
import { enforceThrottle } from '#app/services/auth/enforce-throttle.js'
import { notifyNewSignIn } from '#app/services/auth/new-sign-in-notice.js'
import { internalMessage, unauthorized, type AppResult } from '#app/services/shared/errors.js'
import type { Auth, Session } from '#vendor/types/types.js'
import logger from '#vendor/utils/logger.js'
import { passkeyLoginChallenges } from './passkey-login-challenges.js'
import {
    authenticationOptions,
    ceremonyBinding,
    fromBase64Url,
    verifyWebAuthnCeremony,
    type CeremonyPurpose,
} from './webauthn-ceremony.js'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р6): a sign-in with a passkey alone. A passkey is a
// proof of possession with user verification, so it is a full sign-in: level 2, no second step.
// An unknown key, a key of another account's handle and a bad signature answer the same 401.

const refused = (): AppResult<never> =>
    Result.err(unauthorized('The passkey was not accepted. Try again.'))

/**
 * A signature whose counter did not grow: the key may be cloned. Recorded for the owner; the key
 * stays, the owner decides (Р6).
 */
export async function recordCounterRegression(
    credential: WebAuthnCredentialRow,
    method: Exclude<CeremonyPurpose, 'register'>,
    request: AuditRequest,
): Promise<void> {
    const actor = proofHolderOf('passkey', request)
    try {
        const events = await withTransaction(async (tx) => {
            const stamp = await auditService.stamp(tx)
            return auditService.record(tx, stamp, actor, [
                {
                    action: 'auth.passkey.counter_regressed',
                    targetId: String(credential.userId),
                    targetUserId: credential.userId,
                    input: { method },
                },
            ])
        })
        auditService.logCommitted(actor.logger, events)
    } catch (err) {
        logger.error(
            { err, userId: String(credential.userId) },
            'passkey counter regression not recorded',
        )
    }
}

export const passkeySignIn = {
    /** The options of a passwordless sign-in: any discoverable key of this site. */
    async options(): Promise<AppResult<{ challengeId: string; options: object }>> {
        const options = await authenticationOptions([])
        const challengeId = await passkeyLoginChallenges.issue(options.challenge)
        return Result.ok({ challengeId, options })
    },

    async verify(
        input: { challengeId: string; response: AuthenticationResponse },
        context: { auth: Auth; session: Session; ipAddress: string; request: AuditRequest },
    ): Promise<AppResult<AuthSuccessPayload>> {
        // The same IP budget as a password sign-in: a passkey guess costs as much.
        const throttle = await enforceThrottle(
            throttlePolicies.loginIp,
            context.ipAddress,
            unauthorized('The passkey was not accepted. Try again.'),
        )
        if (Result.isError(throttle)) return Result.err(throttle.error)

        const challenge = await passkeyLoginChallenges.take(input.challengeId)
        if (challenge === null) return refused()
        const credential = await webauthnCredentialRepository.findByCredentialId(
            fromBase64Url(input.response.id),
        )
        if (credential === undefined) return refused()
        const user = await userRepository.findById(credential.userId)
        if (user === undefined) return refused()

        const verified = await verifyWebAuthnCeremony({
            purpose: 'login',
            stored: { challenge, binding: ceremonyBinding('login') },
            expectedBinding: ceremonyBinding('login'),
            response: input.response,
            credential,
            expectedUserId: user.id,
            expectedUserHandle: user.webauthnUserHandle,
        })
        if (!verified.ok) {
            if (verified.failure === 'counter_regressed') {
                await recordCounterRegression(credential, 'login', context.request)
            }
            return refused()
        }
        if (!('assertion' in verified)) return refused()
        // The conditional UPDATE decides between two signatures with the same counter.
        const counted = await webauthnCredentialRepository.recordUse(
            credential.id,
            verified.assertion.newCounter,
        )
        if (counted !== 'advanced') {
            if (counted === 'regressed') {
                await recordCounterRegression(credential, 'login', context.request)
            }
            return refused()
        }

        const loggedIn = await context.auth.login(toEntityId(user.id), user.sessionToken, {
            method: 'passkey',
        })
        if (loggedIn === null) return Result.err(internalMessage('Failed to log in user'))
        notifyNewSignIn(user.id, loggedIn, { mail: true })
        return Result.ok(await authSuccessPayload(user, context.session))
    },
}
