import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from 'shared/limits'

/**
 * What is wrong with the length of a password, by the limits the server enforces (the same
 * constants the auth schemas are checked against in the shared tests); `null` when it fits.
 * An empty value is `empty`, so a form can say "required" before it says "too short".
 */
export type PasswordLengthProblem = 'empty' | 'tooShort' | 'tooLong'

export function passwordLengthProblem(value: string): PasswordLengthProblem | null {
    if (value === '') return 'empty'
    if (value.length < PASSWORD_MIN_LENGTH) return 'tooShort'
    if (value.length > PASSWORD_MAX_LENGTH) return 'tooLong'
    return null
}

/** The i18n key of the message for each problem. */
export const PASSWORD_PROBLEM_MESSAGE_KEY = {
    empty: 'auth.errorPassword',
    tooShort: 'auth.errorPasswordLength',
    tooLong: 'auth.errorPasswordMaxLength',
} as const satisfies Record<PasswordLengthProblem, string>
