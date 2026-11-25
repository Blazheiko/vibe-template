import { Result } from 'better-result'

import { oauthAccountRepository, userRepository, withTransaction } from '#app/repositories/index.js'
import type { DbExecutor, OAuthAccountRow, UserRow } from '#app/repositories/index.js'
import { withProof, withRole } from '#app/services/audit/audit-actor.js'
import { mailSafeDisplayName } from '#app/services/notifications/email-templates.js'
import { asNotificationProvider } from '#app/services/notifications/notification-provider.js'
import { userNotificationService } from '#app/services/notifications/user-notification-service.js'
import { conflict, notFound, sessionRevoked, type AppResult } from '#app/services/shared/errors.js'
import type { SessionAuthState } from 'shared/mfa'
import {
    hasRecoveryContactOf,
    loadMfaAccount,
    loadMfaFactors,
} from '#app/services/auth/mfa/mfa-account.js'
import { requireProof } from '#app/services/auth/mfa/require-proof.js'
import { staffPolicy } from '#app/services/auth/mfa/staff-policy.js'
import logger from '#vendor/utils/logger.js'
import type { UserAuditActor } from '#app/services/audit/audit-actor.js'
import { auditService, type RecordedAuditEvent } from '#app/services/audit/audit-service.js'
import type { OAuthAccountId, UserId } from '#app/domain/ids.js'

// feat-199 (security review 2026-11-12, M-2): an identity of an OAuth provider linked to an
// account signs in to it whatever happens to the password, and the owner could neither see the
// links nor remove one. Here: the list, and the removal of a link.
//
// Removing a link is a change of the ways into the account, so it asks who is asking again:
// feat-245 (row 8 of Р3) through the proof matrix: a fresh password (POST /auth/reauth) without
// MFA, a fresh second factor with it, a recent OAuth sign-in of an account without a password.
// And it never removes the last way in (signInCapability, under the user's row lock).

export const LAST_SIGN_IN_METHOD = 'last_sign_in_method'

export interface SignInMethod {
    id: string
    provider: string
    name: string | null
    linkedAt: string
}

const hasPassword = (user: { password: string | null }): boolean =>
    user.password !== null && user.password !== ''

const serialize = (link: OAuthAccountRow): SignInMethod => ({
    id: String(link.id),
    provider: link.provider,
    // Outside data: shown only when it cannot pass for a link or an address.
    name: link.providerName === null ? null : mailSafeDisplayName(link.providerName),
    linkedAt: link.createdAt.toISOString(),
})

/**
 * feat-245 (Р12): what the account can still do after `change`, counted under the user's row
 * lock. A change that would leave no way to sign in is refused; `meetsStaffMfa` is the staff
 * policy of this deployment (feat-248: `enrolled` of `any` or `passkey`), checked by the factor
 * removals (staffFactorLossError), `hasRecoveryContact` by the passkey rules of feat-246.
 */
export async function signInCapability(
    user: UserRow,
    tx: DbExecutor,
    change: {
        removeOAuthLinkId?: bigint
        removePasskey?: boolean
        removePasskeys?: number
        removeTotp?: boolean
    } = {},
): Promise<{ canSignIn: boolean; meetsStaffMfa: boolean; hasRecoveryContact: boolean }> {
    const links = await oauthAccountRepository.findByUserId(user.id, tx)
    const remainingLinks = links.filter((link) => link.id !== change.removeOAuthLinkId).length
    const factors = await loadMfaFactors(user.id, tx)
    // feat-246: a passkey signs in on its own, so the last one may be the last way in.
    const removed = (change.removePasskey === true ? 1 : 0) + (change.removePasskeys ?? 0)
    const passkeys = Math.max(0, factors.passkeys - removed)
    return {
        canSignIn: hasPassword(user) || remainingLinks > 0 || passkeys > 0,
        meetsStaffMfa: staffPolicy().enrolled({
            totp: factors.totp !== undefined && change.removeTotp !== true,
            passkeys,
        }),
        hasRecoveryContact: hasRecoveryContactOf(user),
    }
}

export interface UnlinkRequest {
    linkId: OAuthAccountId
    /** `Auth.getPresentedUserToken()`: refused once the session was revoked meanwhile. */
    presentedSessionToken: string | undefined
    /** feat-245 (row 8 of Р3): how the session was authenticated. */
    sessionAuth: SessionAuthState | undefined
    /** Asked right before the link is removed: a logout in another tab ends the request. */
    sessionStored: () => Promise<boolean>
    now?: number
    /** feat-235: who removes it: the signed-in user of the request. */
    actor: UserAuditActor
}

export const signInMethodsService = {
    async list(
        userId: UserId,
    ): Promise<AppResult<{ hasPassword: boolean; methods: SignInMethod[] }>> {
        const user = await userRepository.findById(userId)
        if (user === undefined) return Result.err(notFound('User', 'User not found'))
        const links = await oauthAccountRepository.findByUserId(userId)
        return Result.ok({
            hasPassword: hasPassword(user),
            methods: links
                .slice()
                .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
                .map(serialize),
        })
    },

    async unlink(userId: UserId, request: UnlinkRequest): Promise<AppResult<{ provider: string }>> {
        const user = await userRepository.findById(userId)
        if (user === undefined) return Result.err(notFound('User', 'User not found'))
        if (
            request.presentedSessionToken === undefined ||
            user.sessionToken !== request.presentedSessionToken
        ) {
            return Result.err(sessionRevoked())
        }

        const proof = requireProof({
            action: 'oauth.unlink',
            account: await loadMfaAccount(user),
            auth: request.sessionAuth,
            ...(request.now !== undefined ? { now: request.now } : {}),
        })
        if (Result.isError(proof)) return Result.err(proof.error)

        if (!(await request.sessionStored())) return Result.err(sessionRevoked())

        // Under the user's row lock: two removals at once must not both see "one more is left",
        // and a password change or a claim running meanwhile is seen.
        const { actor } = request
        const removed = await withTransaction(
            async (tx): Promise<AppResult<{ provider: string; events: RecordedAuditEvent[] }>> => {
                const locked = await userRepository.lockById(userId, tx)
                if (locked === undefined) return Result.err(notFound('User', 'User not found'))
                if (locked.sessionToken !== request.presentedSessionToken) {
                    return Result.err(sessionRevoked())
                }
                const links = await oauthAccountRepository.findByUserId(userId, tx)
                // A link of another account is "not found", like one that does not exist.
                const link = links.find((candidate) => candidate.id === request.linkId)
                if (link === undefined) {
                    return Result.err(notFound('SignInMethod', 'Sign-in method not found'))
                }
                const after = await signInCapability(locked, tx, { removeOAuthLinkId: link.id })
                if (!after.canSignIn) {
                    return Result.err(
                        conflict(
                            'Set a password before removing your last sign-in method',
                            LAST_SIGN_IN_METHOD,
                        ),
                    )
                }
                const deleted = await oauthAccountRepository.deleteForUser(userId, link.id, tx)
                if (!deleted) {
                    return Result.err(notFound('SignInMethod', 'Sign-in method not found'))
                }
                // feat-235: committed with the removal.
                const stamp = await auditService.stamp(tx)
                const proven = withProof(actor, proof.value)
                const events = await auditService.record(tx, stamp, withRole(proven, locked.role), [
                    {
                        action: 'auth.sign_in_method.unlinked',
                        targetId: String(userId),
                        targetUserId: userId,
                        input: { method: 'oauth', provider: link.provider },
                    },
                ])
                return Result.ok({ provider: link.provider, events })
            },
        )
        if (Result.isError(removed)) return Result.err(removed.error)
        auditService.logCommitted(actor.logger, removed.value.events)

        logger.info(
            { userId: String(userId), provider: removed.value.provider },
            'sign-in method unlinked',
        )
        const provider = asNotificationProvider(removed.value.provider)
        if (provider !== null) {
            userNotificationService.security(userId, 'sign_in_method_removed', { provider })
        }
        return Result.ok({ provider: removed.value.provider })
    },
}
