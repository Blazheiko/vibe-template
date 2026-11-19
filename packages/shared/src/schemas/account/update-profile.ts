import { type } from '@arktype/type'
import { SHIPPED_LOCALE_CODES } from '../../enums/languages.js'
import { COLOR_THEMES, THEMES } from '../../enums/preferences.js'
import { ProfileNameSchema } from './profile-name.js'

/** The `user_preferences.time_zone` column is `varchar(64)`. */
export const PROFILE_TIME_ZONE_MAX_LENGTH = 64

/**
 * PATCH /account/profile (feat-232, Р2–Р4). An absent field is left unchanged; `null` resets a
 * preference to its default (the browser language and zone, the system theme, the default color
 * and font size). `name` cannot be reset. Whether `timeZone` is a known IANA zone is checked by
 * the server with `isAllowedTimeZone`: the list depends on the ICU of the runtime.
 */
export const UpdateProfileInputSchema = type({
    'name?': ProfileNameSchema,
    'locale?': type.enumerated(...SHIPPED_LOCALE_CODES).or('null'),
    'timeZone?': '(1 <= string <= 64) | null',
    'theme?': type.enumerated(...THEMES).or('null'),
    'colorTheme?': type.enumerated(...COLOR_THEMES).or('null'),
    'fontSize?': '(14 <= number.integer <= 20) | null',
    '+': 'reject',
}).narrow(
    (body, ctx) =>
        Object.keys(body).length > 0 ||
        ctx.reject({ expected: 'an object with at least one field' }),
)

export type UpdateProfileInput = typeof UpdateProfileInputSchema.infer
