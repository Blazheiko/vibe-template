import { type } from '@arktype/type'
import { EntityIdSchema } from '../../brands/index.js'

// feat-199: removing a linked sign-in method. feat-245 (row 8 of Р3): allowed by a fresh
// step-up proof of the session (POST /auth/reauth), or a recent OAuth sign-in of an account
// without a password.
export const UnlinkSignInMethodInputSchema = type({
    id: EntityIdSchema,
    '+': 'reject',
})

export type UnlinkSignInMethodInput = typeof UnlinkSignInMethodInputSchema.infer
