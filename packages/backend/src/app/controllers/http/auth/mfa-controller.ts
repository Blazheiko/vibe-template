import type { HttpContext } from '#vendor/types/types.js'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { mapControllerError, respond } from '#app/controllers/shared/controller-error.js'
import { auditActorFrom } from '#app/controllers/shared/audit-actor.js'
import { requireUserId } from '#app/controllers/shared/require-user-id.js'
import { totpService, type TotpRequest } from '#app/services/auth/mfa/totp-service.js'
import { unauthorized } from '#app/services/shared/errors.js'
import type { TotpConfirmInput } from 'shared/schemas'
import type {
    MfaStatusResponse,
    RecoveryCodesResponse,
    TotpConfirmResponse,
    TotpDisableResponse,
    TotpSetupResponse,
} from 'shared/responses'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р7, Р8): the second factors of the signed-in account.

const requestOf = (context: HttpContext, userId: bigint): TotpRequest => ({
    userId,
    session: context.session,
    presentedSessionToken: context.auth.getPresentedUserToken(),
    actor: auditActorFrom(context),
})

export default {
    async status(context: HttpContext): Promise<MfaStatusResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const result = await totpService.status(userId, context.session)
        return respond(context, result, (value) => ({ status: 'success' as const, ...value }))
    },

    async totpSetup(context: HttpContext): Promise<TotpSetupResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const result = await totpService.setup(requestOf(context, userId))
        return respond(context, result, (value) => ({ status: 'success' as const, ...value }))
    },

    async totpConfirm(context: HttpContext<TotpConfirmInput>): Promise<TotpConfirmResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const payload = getTypedPayload(context)
        const result = await totpService.confirm(requestOf(context, userId), {
            enrollmentId: payload.enrollmentId,
            code: payload.code,
        })
        return respond(context, result, (value) => ({ status: 'success' as const, ...value }))
    },

    async totpDisable(context: HttpContext): Promise<TotpDisableResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const result = await totpService.disable(requestOf(context, userId))
        return respond(context, result, (value) => ({ status: 'success' as const, ...value }))
    },

    async regenerateRecoveryCodes(context: HttpContext): Promise<RecoveryCodesResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const result = await totpService.regenerateRecoveryCodes(requestOf(context, userId))
        return respond(context, result, (value) => ({ status: 'success' as const, ...value }))
    },
}
