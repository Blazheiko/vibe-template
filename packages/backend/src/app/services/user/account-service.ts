import { Result } from 'better-result'
import type { Profile } from 'shared'
import type { UpdateProfileInput } from 'shared/schemas'
import { isAllowedTimeZone } from 'shared/utils'
import { throttlePolicies } from '#config/throttle-policies.js'
import {
    userPreferencesRepository,
    userRepository,
    withTransaction,
    type UserPreferencesPatch,
} from '#app/repositories/index.js'
import { profileTransformer } from '#app/transformers/index.js'
import { enforceThrottle } from '#app/services/auth/enforce-throttle.js'
import { userEventBus } from '#app/services/communication/user-event-bus.js'
import logger from '#vendor/utils/logger.js'
import {
    badRequest,
    notFound,
    rateLimited,
    sessionRevoked,
    type AppResult,
} from '#app/services/shared/errors.js'
import type { UserId } from '#app/domain/ids.js'

/**
 * Whether the session record of the request is still stored: a logout in another tab deletes it
 * without rotating users.session_token (feat-123). The controller passes `session.isStored`.
 */
export type SessionStillStored = () => Promise<boolean>

export const UNKNOWN_TIME_ZONE_REASON = 'unknown_time_zone'

const preferencesPatch = (body: UpdateProfileInput): UserPreferencesPatch => {
    const patch: UserPreferencesPatch = {}
    if (body.locale !== undefined) patch.locale = body.locale
    if (body.timeZone !== undefined) patch.timeZone = body.timeZone
    if (body.theme !== undefined) patch.theme = body.theme
    if (body.colorTheme !== undefined) patch.colorTheme = body.colorTheme
    if (body.fontSize !== undefined) patch.fontSize = body.fontSize
    return patch
}

export const accountService = {
    /**
     * The profile as one committed state: the name and the revision from a single statement, so
     * a PATCH that commits meanwhile cannot pair an old name with a new revision (a snapshot
     * like that would win over the right event of the same revision on the client).
     */
    async getProfile(userId: UserId): Promise<AppResult<Profile>> {
        const row = await userPreferencesRepository.findProfileByUserId(userId)
        if (row === undefined) {
            return Result.err(notFound('User', 'User not found'))
        }
        return Result.ok(profileTransformer.serialize(row.name, row.preferences ?? undefined))
    },

    /**
     * PATCH /account/profile (feat-232, Р2–Р5, Р12). The name and the preferences are one
     * transaction; every repository call in it gets the same `tx`. The write happens only while
     * the session is still current, as in a password change: a logout everywhere or a claim
     * rotates users.session_token, a logout in another tab deletes the session record.
     */
    async updateProfile(
        userId: UserId,
        body: UpdateProfileInput,
        presentedSessionToken: string | undefined,
        sessionStored: SessionStillStored,
    ): Promise<AppResult<Profile>> {
        // One rule for writing and reading (Р3): a zone this runtime does not know is refused.
        if (typeof body.timeZone === 'string' && !isAllowedTimeZone(body.timeZone)) {
            return Result.err(badRequest('Unknown time zone', UNKNOWN_TIME_ZONE_REASON))
        }

        const throttle = await enforceThrottle(
            throttlePolicies.accountProfileUser,
            String(userId),
            rateLimited('Too many profile changes. Please try again later.'),
        )
        if (Result.isError(throttle)) {
            return Result.err(throttle.error)
        }

        if (presentedSessionToken === undefined || !(await sessionStored())) {
            return Result.err(sessionRevoked())
        }

        const patch = preferencesPatch(body)
        // No outside call in the transaction: two statements, the users row held only until
        // the upsert commits.
        const saved = await withTransaction(async (tx) => {
            const user =
                body.name === undefined
                    ? await userRepository.shareIfSessionToken(userId, presentedSessionToken, tx)
                    : await userRepository.updateNameIfSessionToken(
                          userId,
                          presentedSessionToken,
                          body.name,
                          tx,
                      )
            if (user === undefined) return undefined
            // An empty patch (the name only) still adds one to the revision (Р12).
            const row = await userPreferencesRepository.applyPatch(userId, patch, tx)
            return profileTransformer.serialize(user.name, row)
        })

        if (saved === undefined) {
            const current = await userRepository.findById(userId)
            return Result.err(
                current === undefined ? notFound('User', 'User not found') : sessionRevoked(),
            )
        }
        // Р9 B: after the commit, to every connection of the user on every instance, this tab
        // included (the client applies it by revision). The answer does not wait for it.
        userEventBus
            .publishToUser(String(userId), 'user_profile_updated', saved)
            .catch((err: unknown) => {
                logger.warn({ err, userId: String(userId) }, 'Profile update event not sent')
            })
        return Result.ok(saved)
    },
}
