import type { UpdateProfileInputSchema } from '../schemas/account/update-profile.js'
import type { GetProfileResponse, UpdateProfileResponse } from '../responses/account-controller.js'
import { contract } from './core.js'

export const accountContracts = {
    getProfile: contract<undefined, undefined, GetProfileResponse>()('get', '/account/profile'),
    // Partial body: an absent field is unchanged, `null` resets a preference (feat-232, Р2).
    updateProfile: contract<
        typeof UpdateProfileInputSchema.inferIn,
        undefined,
        UpdateProfileResponse
    >()('patch', '/account/profile'),
} as const
