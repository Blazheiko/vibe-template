import type { HttpContext } from '#vendor/types/types.js'
import { presentedSessionTokenOf } from '#app/domain/secrets.js'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { accountService } from '#app/services/user/account-service.js'
import { mapControllerError, respond } from '#app/controllers/shared/controller-error.js'
import { requireUserId } from '#app/controllers/shared/require-user-id.js'
import { notFound, unauthorized } from '#app/services/shared/errors.js'
import { userRoleService } from '#app/services/user/user-role-service.js'
import type { UpdateProfileInput } from 'shared/schemas'
import type { GetAccessResponse, GetProfileResponse, UpdateProfileResponse } from 'shared/responses'

export default {
    async getProfile(context: HttpContext): Promise<GetProfileResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const result = await accountService.getProfile(userId)
        return respond(context, result, (profile) => ({ status: 'success', profile }))
    },

    /** feat-240 (Р8): the role of the signed-in user, from the database. */
    async getAccess(context: HttpContext): Promise<GetAccessResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }
        const role = await userRoleService.findRole(userId)
        if (role === undefined) {
            return mapControllerError(context, notFound('User', 'User not found'))
        }
        return { status: 'success', role }
    },

    async updateProfile(context: HttpContext<UpdateProfileInput>): Promise<UpdateProfileResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const result = await accountService.updateProfile(
            userId,
            getTypedPayload(context),
            presentedSessionTokenOf(context.auth.getPresentedUserToken()),
            () => context.session.isStored(),
        )
        return respond(context, result, (profile) => ({ status: 'success', profile }))
    },
}
