import type { HttpContext } from '#vendor/types/types.js'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { mapControllerError, respond } from '#app/controllers/shared/controller-error.js'
import { auditActorFrom } from '#app/controllers/shared/audit-actor.js'
import { parseEntityId } from '#app/controllers/shared/parse-id.js'
import { requireUserId } from '#app/controllers/shared/require-user-id.js'
import { passkeyService, type PasskeyRequest } from '#app/services/auth/mfa/passkey-service.js'
import { notFound, unauthorized, type AppError } from '#app/services/shared/errors.js'
import type { PasskeyRegisterInput, PasskeyRenameInput } from 'shared/schemas'
import type {
    PasskeyDeleteResponse,
    PasskeyListResponse,
    PasskeyOptionsResponse,
    PasskeyRegisterResponse,
    PasskeyRenameResponse,
    WebAuthnCreationOptions,
} from 'shared/responses'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р6): the passkeys of the signed-in account.

const requestOf = (context: HttpContext, userId: bigint): PasskeyRequest => ({
    userId,
    session: context.session,
    presentedSessionToken: context.auth.getPresentedUserToken(),
    actor: auditActorFrom(context),
})

const passkeyNotFound = (): AppError => notFound('Passkey', 'Passkey not found')

/** A path id that is not a stored id answers like a passkey of another user. */
const positiveId = (raw: string | undefined): bigint | null => {
    const id = parseEntityId(raw)
    return id !== null && id > 0n ? id : null
}

export default {
    async list(context: HttpContext): Promise<PasskeyListResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const result = await passkeyService.list(userId)
        return respond(context, result, (passkeys) => ({ status: 'success' as const, passkeys }))
    },

    async registerOptions(context: HttpContext): Promise<PasskeyOptionsResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const result = await passkeyService.registerOptions(requestOf(context, userId))
        return respond(context, result, (value) => ({
            status: 'success' as const,
            enrollmentId: value.enrollmentId,
            // The library's JSON options; the response schema checks every field of them.
            options: value.options as WebAuthnCreationOptions,
        }))
    },

    async register(context: HttpContext<PasskeyRegisterInput>): Promise<PasskeyRegisterResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const payload = getTypedPayload(context)
        const result = await passkeyService.register(requestOf(context, userId), {
            enrollmentId: payload.enrollmentId,
            ...(payload.name !== undefined ? { name: payload.name } : {}),
            response: payload.response,
        })
        return respond(context, result, (value) => ({ status: 'success' as const, ...value }))
    },

    async rename(
        context: HttpContext<PasskeyRenameInput, null, { id: string }>,
    ): Promise<PasskeyRenameResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const id = positiveId(context.httpData.params.id)
        if (id === null) return mapControllerError(context, passkeyNotFound())
        const result = await passkeyService.rename(userId, id, getTypedPayload(context).name)
        return respond(context, result, (passkey) => ({ status: 'success' as const, passkey }))
    },

    async remove(
        context: HttpContext<unknown, null, { id: string }>,
    ): Promise<PasskeyDeleteResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const id = positiveId(context.httpData.params.id)
        if (id === null) return mapControllerError(context, passkeyNotFound())
        const result = await passkeyService.remove(requestOf(context, userId), id)
        return respond(context, result, (value) => ({ status: 'success' as const, ...value }))
    },
}
