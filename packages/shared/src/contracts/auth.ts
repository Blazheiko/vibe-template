import type { LoginInputSchema } from '../schemas/auth/login.js'
import type { LoginResponse } from '../responses/auth-controller.js'
import { contract } from './core.js'

export const authContracts = {
    login: contract<typeof LoginInputSchema.inferIn, undefined, LoginResponse>()(
        'post',
        '/auth/login',
    ),
} as const
