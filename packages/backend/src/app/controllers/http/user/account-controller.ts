import type { HttpContext } from '#vendor/types/types.js'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { accountService } from '#app/services/user/account-service.js'
import { mapControllerError, respond } from '#app/controllers/shared/controller-error.js'
import { requireUserId } from '#app/controllers/shared/require-user-id.js'
import { unauthorized } from '#app/services/shared/errors.js'
import type { UpdateProfileInput } from 'shared/schemas'
import type { GetProfileResponse, UpdateProfileResponse } from 'shared/responses'

export default {
    async getProfile(context: HttpContext): Promise<GetProfileResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const result = await accountService.getProfile(userId)
        return respond(context, result, (profile) => ({ status: 'success', profile }))
    },

    async updateProfile(context: HttpContext<UpdateProfileInput>): Promise<UpdateProfileResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const result = await accountService.updateProfile(
            userId,
            getTypedPayload(context),
            context.auth.getPresentedUserToken(),
            () => context.session.isStored(),
        )
        return respond(context, result, (profile) => ({ status: 'success', profile }))
    },
}
