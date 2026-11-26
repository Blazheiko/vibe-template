import { type } from '@arktype/type'

/**
 * An e-mail address as a client sends it (feat-266): a valid address of at most 255 characters,
 * the length of users.email. Not normalized and not branded: the backend makes the stored form
 * with `normalizeEmail` (a `NormalizedEmail`), the only constructor of that brand.
 */
export const EmailInputSchema = type('string.email & string <= 255')
