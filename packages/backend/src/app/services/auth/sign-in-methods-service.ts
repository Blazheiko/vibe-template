import { validatePassword } from 'metautil'
import { Result } from 'better-result'

import { throttlePolicies } from '#config/throttle-policies.js'
import { oauthAccountRepository, userRepository, withTransaction } from '#app/repositories/index.js'
import type { OAuthAccountRow } from '#app/repositories/index.js'
import { resetAuthThrottle } from '#app/services/auth/auth-throttle-service.js'
import { enforceThrottle } from '#app/services/auth/enforce-throttle.js'
import { mailSafeDisplayName } from '#app/services/notifications/email-templates.js'
import { userNotificationService } from '#app/services/notifications/user-notification-service.js'
import {
    badRequest,
    conflict,
    forbidden,
    notFound,
    rateLimited,
    sessionRevoked,
    type AppResult,
} from '#app/services/shared/errors.js'
import logger from '#vendor/utils/logger.js'

// feat-199 (security review 2026-11-12, M-2): an identity of an OAuth provider linked to an
// account signs in to it whatever happens to the password, and the owner could neither see the
// links nor remove one. Here: the list, and the removal of a link.
//
// Removing a link is a change of the ways into the account, so it asks who is asking again:
// - an account with a password gives the current one (the budget of change-password);
// - an account without one must have signed in within RECENT_SIGN_IN_MS. A sign-in always
//   creates a new session, so the age of the session is the age of the sign-in.
// And it never removes the last way in: an account without a password keeps at least one link.

export const RECENT_SIGN_IN_MS = 10 * 60_000

export const RECENT_SIGN_IN_REQUIRED = 'recent_sign_in_required'
export const LAST_SIGN_IN_METHOD = 'last_sign_in_method'
export const CURRENT_PASSWORD_REQUIRED = 'current_password_required'
export const CURRENT_PASSWORD_INCORRECT = 'current_password_incorrect'

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

const isRecent = (sessionCreatedAt: string | undefined, now: number): boolean => {
    if (sessionCreatedAt === undefined) return false
    const createdAt = Date.parse(sessionCreatedAt)
    if (Number.isNaN(createdAt)) return false
    const age = now - createdAt
    // A session from the future is not a recent sign-in.
    return age >= 0 && age <= RECENT_SIGN_IN_MS
}

export interface UnlinkRequest {
    linkId: bigint
    currentPassword: string | undefined
    /** `Auth.getPresentedUserToken()`: refused once the session was revoked meanwhile. */
    presentedSessionToken: string | undefined
    /** `createdAt` of the request's session: the moment of its sign-in. */
    sessionCreatedAt: string | undefined
    /** Asked right before the link is removed: a logout in another tab ends the request. */
    sessionStored: () => Promise<boolean>
    now?: number
}

export const signInMethodsService = {
    async list(
        userId: bigint,
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

    async unlink(userId: bigint, request: UnlinkRequest): Promise<AppResult<{ provider: string }>> {
        const user = await userRepository.findById(userId)
        if (user === undefined) return Result.err(notFound('User', 'User not found'))
        if (
            request.presentedSessionToken === undefined ||
            user.sessionToken !== request.presentedSessionToken
        ) {
            return Result.err(sessionRevoked())
        }

        const passwordHash = user.password
        if (passwordHash !== null && passwordHash !== '') {
            if (request.currentPassword === undefined || request.currentPassword === '') {
                return Result.err(
                    badRequest('Current password is required', CURRENT_PASSWORD_REQUIRED),
                )
            }
            // Spent before the check, from the per-user budget of change-password: a stolen
            // session cannot guess the password here (feat-109).
            const throttle = await enforceThrottle(
                throttlePolicies.changePasswordUser,
                String(userId),
                rateLimited('Too many password attempts. Please try again later.'),
            )
            if (Result.isError(throttle)) return Result.err(throttle.error)

            if (!(await validatePassword(request.currentPassword, passwordHash))) {
                return Result.err(
                    badRequest('Current password is incorrect', CURRENT_PASSWORD_INCORRECT),
                )
            }
            try {
                await resetAuthThrottle(throttlePolicies.changePasswordUser, String(userId))
            } catch (err: unknown) {
                logger.warn({ err }, 'Password re-check throttle reset failed')
            }
        } else if (!isRecent(request.sessionCreatedAt, request.now ?? Date.now())) {
            return Result.err(
                forbidden('Sign in again to remove a sign-in method', RECENT_SIGN_IN_REQUIRED),
            )
        }

        if (!(await request.sessionStored())) return Result.err(sessionRevoked())

        // Under the user's row lock: two removals at once must not both see "one more is left",
        // and a password change or a claim running meanwhile is seen.
        const removed = await withTransaction(
            async (tx): Promise<AppResult<{ provider: string }>> => {
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
                if (!hasPassword(locked) && links.length === 1) {
                    return Result.err(
                        conflict(
                            'Set a password before removing your last sign-in method',
                            LAST_SIGN_IN_METHOD,
                        ),
                    )
                }
                const deleted = await oauthAccountRepository.deleteByIdForUser(link.id, userId, tx)
                if (!deleted) {
                    return Result.err(notFound('SignInMethod', 'Sign-in method not found'))
                }
                return Result.ok({ provider: link.provider })
            },
        )
        if (Result.isError(removed)) return Result.err(removed.error)

        logger.info(
            { userId: String(userId), provider: removed.value.provider },
            'sign-in method unlinked',
        )
        userNotificationService.security(userId, 'sign_in_method_removed')
        return Result.ok(removed.value)
    },
}
