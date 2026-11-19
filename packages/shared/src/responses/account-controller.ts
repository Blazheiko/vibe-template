import { type } from '@arktype/type'
import { SHIPPED_LOCALE_CODES } from '../enums/languages.js'
import { COLOR_THEMES, THEMES } from '../enums/preferences.js'
import { CanonicalErrorResponseSchema, type WithCanonicalError } from './error-response.js'

/**
 * A preference is the user's explicit choice or `null` (no choice: the client shows its default,
 * Р2). A user without a `user_preferences` row has every preference `null`.
 */
export const ProfilePreferencesSchema = type({
    locale: type.enumerated(...SHIPPED_LOCALE_CODES).or('null'),
    timeZone: 'string | null',
    theme: type.enumerated(...THEMES).or('null'),
    colorTheme: type.enumerated(...COLOR_THEMES).or('null'),
    fontSize: '(14 <= number.integer <= 20) | null',
})
export type ProfilePreferences = typeof ProfilePreferencesSchema.infer

/**
 * The profile revision (Р12): a decimal string like the ids, `"0"` while the user has no
 * `user_preferences` row. Clients compare it as a number (`BigInt`), never as a string.
 */
export const ProfileRevisionSchema = type(/^(?:0|[1-9]\d*)$/)

export const ProfileSchema = type({
    name: 'string',
    preferences: ProfilePreferencesSchema,
    revision: ProfileRevisionSchema,
})
export type Profile = typeof ProfileSchema.infer

export const GetProfileResponseSchema = type.or(
    { status: "'success'", profile: ProfileSchema },
    CanonicalErrorResponseSchema,
)
export type GetProfileResponse = WithCanonicalError<typeof GetProfileResponseSchema.infer>

export const UpdateProfileResponseSchema = type.or(
    { status: "'success'", profile: ProfileSchema },
    CanonicalErrorResponseSchema,
)
export type UpdateProfileResponse = WithCanonicalError<typeof UpdateProfileResponseSchema.infer>
