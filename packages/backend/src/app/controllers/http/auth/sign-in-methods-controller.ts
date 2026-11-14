import type { HttpContext } from '#vendor/types/types.js'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { mapControllerError, respond } from '#app/controllers/shared/controller-error.js'
import { requireUserId } from '#app/controllers/shared/require-user-id.js'
import { signInMethodsService } from '#app/services/auth/sign-in-methods-service.js'
import { unauthorized } from '#app/services/shared/errors.js'
import type { UnlinkSignInMethodInput } from 'shared/schemas'
import type { GetSignInMethodsResponse, UnlinkSignInMethodResponse } from 'shared/responses'

// feat-199: the sign-in methods linked to the signed-in account.
export default {
    async list(context: HttpContext): Promise<GetSignInMethodsResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())

        const result = await signInMethodsService.list(userId)
        return respond(context, result, (value) => ({ status: 'success' as const, ...value }))
    },

    async unlink(
        context: HttpContext<UnlinkSignInMethodInput>,
    ): Promise<UnlinkSignInMethodResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())

        const payload = getTypedPayload(context)
        const result = await signInMethodsService.unlink(userId, {
            linkId: BigInt(payload.id),
            currentPassword: payload.currentPassword,
            presentedSessionToken: context.auth.getPresentedUserToken(),
            sessionCreatedAt: context.session.sessionInfo?.createdAt,
            sessionStored: () => context.session.isStored(),
        })
        return respond(context, result, () => ({ status: 'success' as const }))
    },
}
