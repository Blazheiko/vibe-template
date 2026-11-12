import { type } from '@arktype/type'
import { PASSWORD_MAX_LENGTH } from '../../limits/index.js'

export const VerifyEmailInputSchema = type({
    token: 'string >= 1 & string <= 255',
    // feat-097: a registration link confirms the account only with its password (or from a
    // session of that account), so a link clicked by somebody who did not register does
    // nothing. Any non-empty password up to the longest one: a shorter one than the auth
    // schemas take is just a wrong password, answered as `invalid_password` like any other.
    'password?': type('string').atLeastLength(1).atMostLength(PASSWORD_MAX_LENGTH),
    '+': 'reject',
})

export type VerifyEmailInput = typeof VerifyEmailInputSchema.infer
