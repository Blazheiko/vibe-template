import { type } from '@arktype/type'

/** The `users.name` column is `varchar(100)`: PostgreSQL counts characters (code points). */
export const PROFILE_NAME_MAX_LENGTH = 100

// Control characters (\p{Cc}, which holds \n, \r, \t and \u0085) and the Unicode line and
// paragraph separators: a name is shown on one line in the header, the admin list and emails.
const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\u2028\u2029]/u

const NormalizedProfileName = type('string')
    .narrow((value, ctx) => value.length > 0 || ctx.reject({ expected: 'non-empty', actual: '""' }))
    .narrow(
        (value, ctx) =>
            [...value].length <= PROFILE_NAME_MAX_LENGTH ||
            ctx.reject({ expected: `at most ${String(PROFILE_NAME_MAX_LENGTH)} characters` }),
    )
    .narrow(
        (value, ctx) =>
            !FORBIDDEN_NAME_CHARACTERS.test(value) ||
            ctx.reject({ expected: 'free of control characters and line breaks' }),
    )

/**
 * A profile name (feat-232, Р3): NFC-normalized and trimmed, then 1–100 characters without
 * control characters or line breaks. The raw input is bounded first so a huge string is never
 * normalized. The registration schemas keep their own simpler rule for now.
 */
export const ProfileNameSchema = type('string <= 1000')
    .pipe((value) => value.normalize('NFC').trim())
    .to(NormalizedProfileName)
