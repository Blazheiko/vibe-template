import { type } from '@arktype/type'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../limits/index.js'

/**
 * A password as the auth schemas take it: the bounds of `shared/limits`, which the browser
 * checks too. Every password field uses this schema instead of repeating the numbers.
 */
export const PasswordSchema = type('string')
    .atLeastLength(PASSWORD_MIN_LENGTH)
    .atMostLength(PASSWORD_MAX_LENGTH)
