import type { HttpContext } from '#vendor/types/types.js'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { mapControllerError } from '#app/controllers/shared/controller-error.js'
import { authService } from '#app/services/auth/auth-service.js'
import { Result } from 'better-result'
import type {
    ChangePasswordResponse,
    ForgotPasswordResponse,
    LoginResponse,
    LogoutResponse,
    LogoutAllResponse,
    ResetPasswordResponse,
    VerifyEmailResponse,
    ResendVerificationEmailResponse,
    RegisterEmailResponse,
    RegisterPhoneStartResponse,
    RegisterPhoneConfirmResponse,
    RegisterPhoneCompleteResponse,
    LinkPhoneStartResponse,
    LinkPhoneConfirmResponse,
    LinkEmailStartResponse,
    ResetPhoneStartResponse,
    ResetPhoneCompleteResponse,
} from 'shared'
import type {
    ChangePasswordInput,
    EmptyFormInput,
    ForgotPasswordInput,
    LoginInput,
    ResetPasswordInput,
    VerifyEmailInput,
    RegisterEmailInput,
    RegisterPhoneStartInput,
    RegisterPhoneConfirmInput,
    RegisterPhoneCompleteInput,
    LinkPhoneStartInput,
    LinkPhoneConfirmInput,
    LinkEmailStartInput,
    ResetPhoneStartInput,
    ResetPhoneCompleteInput,
} from 'shared/schemas'
import { emailVerificationService } from '#app/services/auth/email-verification-service.js'
import {
    GENERIC_RESET_MESSAGE,
    passwordResetService,
} from '#app/services/auth/password-reset-service.js'
import { appErrorReason, unauthorized } from '#app/services/shared/errors.js'

const RESET_PASSWORD_REASONS = new Set([
    'invalid_token',
    'expired_token',
    'used_token',
    'token_required',
    'passwords_mismatch',
] as const)

type ResetPasswordReason =
    'invalid_token' | 'expired_token' | 'used_token' | 'token_required' | 'passwords_mismatch'

function getResetPasswordReason(reason: string | undefined): ResetPasswordReason | undefined {
    if (reason === undefined || !RESET_PASSWORD_REASONS.has(reason as ResetPasswordReason)) {
        return undefined
    }

    return reason as ResetPasswordReason
}

function getSessionIdForPhoneBoundFlow(
    context: Pick<HttpContext, 'logger' | 'session' | 'httpData'>,
    operation:
        | 'startPhoneRegistration'
        | 'completePhoneRegistration'
        | 'startPhonePasswordReset'
        | 'startPhoneLink'
        | 'confirmPhoneLink',
): string | null {
    const sessionId = context.session.sessionInfo?.id ?? null

    if (sessionId === null) {
        context.logger.warn(
            {
                operation,
                ipAddress: context.httpData.ip ?? null,
            },
            'Expected session for phone-bound auth flow, but no session was allocated',
        )
    }

    return sessionId
}

export default {
    async registerByEmail(
        context: HttpContext<RegisterEmailInput>,
    ): Promise<RegisterEmailResponse> {
        context.logger.info('registerByEmail handler')
        const payload = getTypedPayload(context)
        const result = await authService.registerByEmail(
            payload,
            context.auth,
            context.session,
            context.logger,
            { ipAddress: context.httpData.ip ?? '' },
        )

        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return result.value
    },

    async startPhoneRegistration(
        context: HttpContext<RegisterPhoneStartInput>,
    ): Promise<RegisterPhoneStartResponse> {
        context.logger.info('startPhoneRegistration handler')
        const payload = getTypedPayload(context)
        const result = await authService.startPhoneRegistration(payload, {
            ipAddress: context.httpData.ip ?? '',
            sessionId: getSessionIdForPhoneBoundFlow(context, 'startPhoneRegistration'),
        })

        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return result.value
    },

    async confirmPhoneRegistration(
        context: HttpContext<RegisterPhoneConfirmInput>,
    ): Promise<RegisterPhoneConfirmResponse> {
        context.logger.info('confirmPhoneRegistration handler')
        const payload = getTypedPayload(context)
        const result = await authService.confirmPhoneRegistration(payload, {
            ipAddress: context.httpData.ip ?? '',
        })

        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return result.value
    },

    async completePhoneRegistration(
        context: HttpContext<RegisterPhoneCompleteInput>,
    ): Promise<RegisterPhoneCompleteResponse> {
        context.logger.info('completePhoneRegistration handler')
        const payload = getTypedPayload(context)
        const result = await authService.completePhoneRegistration(
            payload,
            context.auth,
            context.session,
            context.logger,
            {
                sessionId: getSessionIdForPhoneBoundFlow(context, 'completePhoneRegistration'),
            },
        )

        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return result.value
    },

    async login(context: HttpContext<LoginInput>): Promise<LoginResponse> {
        context.logger.info('login handler')

        const payload = getTypedPayload(context)
        const result = await authService.login(payload, context.auth, context.session, {
            ipAddress: context.httpData.ip ?? '',
        })

        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return result.value
    },

    async logout(context: HttpContext<EmptyFormInput>): Promise<LogoutResponse> {
        context.logger.info('logout handler')
        const result = await authService.logout(context.auth, context.session)
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return result.value
    },

    async logoutAll(context: HttpContext<EmptyFormInput>): Promise<LogoutAllResponse> {
        context.logger.info('logoutAll handler')
        const result = await authService.logoutAll(context.auth, context.session)
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return result.value
    },

    async changePassword(
        context: HttpContext<ChangePasswordInput>,
    ): Promise<ChangePasswordResponse> {
        context.logger.info('changePassword handler')

        if (!context.auth.check()) {
            return mapControllerError(context, unauthorized())
        }

        const userId = context.auth.getUserId()
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const payload = getTypedPayload(context)
        const result = await authService.changePassword(BigInt(userId), payload)
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        // The password is already changed: a failed session renewal does not undo
        // that, so the answer stays a success and says the session was not renewed.
        // The previous session may be gone; the client then signs in again.
        const renewed = await authService.renewSession(
            context.auth,
            context.session,
            result.value.sessionToken,
        )
        if (Result.isError(renewed)) {
            context.logger.error(
                { err: renewed.error },
                'Session renewal after password change failed',
            )
            return { status: 'success', sessionRenewed: false }
        }

        return { status: 'success', sessionRenewed: true, ...renewed.value }
    },

    async forgotPassword(
        context: HttpContext<ForgotPasswordInput>,
    ): Promise<ForgotPasswordResponse> {
        const payload = getTypedPayload(context)
        const result = await passwordResetService.requestPasswordReset(payload.email, {
            ipAddress: context.httpData.ip ?? '',
        })
        return {
            status: 'success',
            message: Result.isOk(result) ? result.value.message : GENERIC_RESET_MESSAGE,
        }
    },

    async startPhonePasswordReset(
        context: HttpContext<ResetPhoneStartInput>,
    ): Promise<ResetPhoneStartResponse> {
        const payload = getTypedPayload(context)
        const result = await passwordResetService.startPhonePasswordReset(
            payload.phone,
            payload.defaultCountry,
            {
                ipAddress: context.httpData.ip ?? '',
                sessionId: getSessionIdForPhoneBoundFlow(context, 'startPhonePasswordReset'),
            },
        )
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        const response: ResetPhoneStartResponse = {
            status: 'success',
            message: result.value.message,
        }
        if (result.value.challengeId !== undefined) {
            response.challengeId = result.value.challengeId
        }
        if (result.value.expiresAt !== undefined) {
            response.expiresAt = result.value.expiresAt
        }
        if (result.value.resendAvailableAt !== undefined) {
            response.resendAvailableAt = result.value.resendAvailableAt
        }
        return response
    },

    async resetPassword(context: HttpContext<ResetPasswordInput>): Promise<ResetPasswordResponse> {
        const payload = getTypedPayload(context)
        const result = await passwordResetService.resetPassword(
            payload.token,
            payload.password,
            payload.passwordConfirm,
            { ipAddress: context.httpData.ip ?? '' },
        )
        if (Result.isError(result)) {
            const error = mapControllerError(context, result.error)
            const reason = getResetPasswordReason(appErrorReason(result.error))
            const { reason: _rawReason, ...baseError } = error
            return reason !== undefined ? { ...baseError, reason } : baseError
        }

        return { status: 'success' }
    },

    async completePhonePasswordReset(
        context: HttpContext<ResetPhoneCompleteInput>,
    ): Promise<ResetPhoneCompleteResponse> {
        const payload = getTypedPayload(context)
        const result = await passwordResetService.completePhonePasswordReset(
            payload.challengeId,
            payload.code,
            payload.password,
            payload.passwordConfirm,
            { ipAddress: context.httpData.ip ?? '' },
        )
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return { status: 'success', message: 'Password reset successfully' }
    },

    async verifyEmail(context: HttpContext<VerifyEmailInput>): Promise<VerifyEmailResponse> {
        const payload = getTypedPayload(context)
        const result = await emailVerificationService.verifyEmail(payload.token, {
            ipAddress: context.httpData.ip ?? '',
        })
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return { status: 'success', message: result.value.message }
    },

    async resendVerificationEmail(
        context: HttpContext<EmptyFormInput>,
    ): Promise<ResendVerificationEmailResponse> {
        const userId = context.auth.getUserId()
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const result = await emailVerificationService.queueVerificationEmail(BigInt(userId))
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return { status: 'success', message: result.value.message }
    },

    async startPhoneLink(
        context: HttpContext<LinkPhoneStartInput>,
    ): Promise<LinkPhoneStartResponse> {
        const userId = context.auth.getUserId()
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const payload = getTypedPayload(context)
        const result = await authService.startPhoneLink(BigInt(userId), payload, {
            ipAddress: context.httpData.ip ?? '',
            sessionId: getSessionIdForPhoneBoundFlow(context, 'startPhoneLink'),
        })
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return result.value
    },

    async confirmPhoneLink(
        context: HttpContext<LinkPhoneConfirmInput>,
    ): Promise<LinkPhoneConfirmResponse> {
        const userId = context.auth.getUserId()
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const payload = getTypedPayload(context)
        const result = await authService.confirmPhoneLink(BigInt(userId), payload, {
            ipAddress: context.httpData.ip ?? '',
            sessionId: getSessionIdForPhoneBoundFlow(context, 'confirmPhoneLink'),
        })
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return result.value
    },

    async startEmailLink(
        context: HttpContext<LinkEmailStartInput>,
    ): Promise<LinkEmailStartResponse> {
        const userId = context.auth.getUserId()
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const payload = getTypedPayload(context)
        const result = await authService.startEmailLink(BigInt(userId), payload)
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return result.value
    },
}
