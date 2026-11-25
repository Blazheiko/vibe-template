import type { HttpContext } from '#vendor/types/types.js'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { mapControllerError, respond } from '#app/controllers/shared/controller-error.js'
import { auditActorFrom } from '#app/controllers/shared/audit-actor.js'
import { requireUserId } from '#app/controllers/shared/require-user-id.js'
import { signInMethodsService } from '#app/services/auth/sign-in-methods-service.js'
import { notFound, unauthorized, type AppError } from '#app/services/shared/errors.js'
import { parseOAuthAccountId } from '#app/domain/ids.js'
import type { UnlinkSignInMethodInput } from 'shared/schemas'
import type { GetSignInMethodsResponse, UnlinkSignInMethodResponse } from 'shared/responses'

// feat-199: the sign-in methods linked to the signed-in account.
const signInMethodNotFound = (): AppError => notFound('SignInMethod', 'Sign-in method not found')

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

        // The schema has refused anything that is not an id (422); parsing again keeps the bigint
        // bound here too, so the service never sees a value PostgreSQL cannot hold (feat-262).
        const linkId = parseOAuthAccountId(getTypedPayload(context).id)
        if (linkId === null) return mapControllerError(context, signInMethodNotFound())
        const result = await signInMethodsService.unlink(userId, {
            linkId,
            presentedSessionToken: context.auth.getPresentedUserToken(),
            sessionAuth: context.session.sessionInfo?.data.auth,
            sessionStored: () => context.session.isStored(),
            actor: auditActorFrom(context),
        })
        return respond(context, result, () => ({ status: 'success' as const }))
    },
}
