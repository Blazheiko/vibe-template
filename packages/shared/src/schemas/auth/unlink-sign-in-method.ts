import { type } from '@arktype/type'
import { EntityIdSchema } from '../../brands/index.js'
import { PasswordSchema } from './password.js'

// feat-199: removing a linked sign-in method. The current password is sent by an account that
// has one; an account without a password must have signed in recently instead.
export const UnlinkSignInMethodInputSchema = type({
    id: EntityIdSchema,
    'currentPassword?': PasswordSchema,
    '+': 'reject',
})

export type UnlinkSignInMethodInput = typeof UnlinkSignInMethodInputSchema.infer
