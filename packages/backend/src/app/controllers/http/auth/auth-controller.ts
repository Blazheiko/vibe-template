import type { HttpContext } from '#vendor/types/types.js'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { mapControllerError, respond } from '#app/controllers/shared/controller-error.js'
import { requireUserId } from '#app/controllers/shared/require-user-id.js'
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
import { unauthorized } from '#app/services/shared/errors.js'

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
        const payload = getTypedPayload(context)
        const result = await authService.registerByEmail(
            payload,
            context.auth,
            context.session,
            context.logger,
            { ipAddress: context.httpData.ip ?? '' },
        )
        return respond(context, result)
    },

    async startPhoneRegistration(
        context: HttpContext<RegisterPhoneStartInput>,
    ): Promise<RegisterPhoneStartResponse> {
        const payload = getTypedPayload(context)
        const result = await authService.startPhoneRegistration(payload, {
            ipAddress: context.httpData.ip ?? '',
            sessionId: getSessionIdForPhoneBoundFlow(context, 'startPhoneRegistration'),
        })
        return respond(context, result)
    },

    async confirmPhoneRegistration(
        context: HttpContext<RegisterPhoneConfirmInput>,
    ): Promise<RegisterPhoneConfirmResponse> {
        const payload = getTypedPayload(context)
        const result = await authService.confirmPhoneRegistration(payload, {
            ipAddress: context.httpData.ip ?? '',
        })
        return respond(context, result)
    },

    async completePhoneRegistration(
        context: HttpContext<RegisterPhoneCompleteInput>,
    ): Promise<RegisterPhoneCompleteResponse> {
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
        return respond(context, result)
    },

    async login(context: HttpContext<LoginInput>): Promise<LoginResponse> {
        const payload = getTypedPayload(context)
        const result = await authService.login(payload, context.auth, context.session, {
            ipAddress: context.httpData.ip ?? '',
        })
        return respond(context, result)
    },

    async logout(context: HttpContext<EmptyFormInput>): Promise<LogoutResponse> {
        const result = await authService.logout(context.auth, context.session)
        return respond(context, result)
    },

    async logoutAll(context: HttpContext<EmptyFormInput>): Promise<LogoutAllResponse> {
        const result = await authService.logoutAll(context.auth, context.session)
        return respond(context, result)
    },

    async changePassword(
        context: HttpContext<ChangePasswordInput>,
    ): Promise<ChangePasswordResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const payload = getTypedPayload(context)
        const result = await authService.changePassword(
            userId,
            payload,
            context.auth.getPresentedUserToken(),
        )
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        // The password is already changed: a failed session renewal does not undo
        // that, so the answer stays a success and says the session was not renewed.
        // The previous session may be gone; the client then signs in again.
        // Since ADR 0004 a storage failure throws instead of returning an error: both mean
        // the same here and must not turn a done password change into a 500.
        const renewed = await authService
            .renewSession(context.auth, context.session, result.value.sessionToken)
            .catch((err: unknown) => Result.err(err))
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
        return respond(context, result, (value) => ({ status: 'success', ...value }))
    },

    async resetPassword(context: HttpContext<ResetPasswordInput>): Promise<ResetPasswordResponse> {
        const payload = getTypedPayload(context)
        const result = await passwordResetService.resetPassword(
            payload.token,
            payload.password,
            payload.passwordConfirm,
            { ipAddress: context.httpData.ip ?? '' },
        )
        // The service's reasons (invalid_token, expired_token, used_token, token_required,
        // passwords_mismatch) pass through the canonical error body as they are.
        return respond(context, result, () => ({ status: 'success' }))
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
        return respond(context, result, () => ({
            status: 'success',
            message: 'Password reset successfully',
        }))
    },

    async verifyEmail(context: HttpContext<VerifyEmailInput>): Promise<VerifyEmailResponse> {
        const payload = getTypedPayload(context)
        const result = await emailVerificationService.verifyEmail(payload.token, {
            ipAddress: context.httpData.ip ?? '',
        })
        return respond(context, result, (value) => ({ status: 'success', message: value.message }))
    },

    async resendVerificationEmail(
        context: HttpContext<EmptyFormInput>,
    ): Promise<ResendVerificationEmailResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const result = await emailVerificationService.queueVerificationEmail(userId)
        return respond(context, result, (value) => ({ status: 'success', message: value.message }))
    },

    async startPhoneLink(
        context: HttpContext<LinkPhoneStartInput>,
    ): Promise<LinkPhoneStartResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const payload = getTypedPayload(context)
        const result = await authService.startPhoneLink(userId, payload, {
            ipAddress: context.httpData.ip ?? '',
            sessionId: getSessionIdForPhoneBoundFlow(context, 'startPhoneLink'),
            presentedSessionToken: context.auth.getPresentedUserToken(),
        })
        return respond(context, result)
    },

    async confirmPhoneLink(
        context: HttpContext<LinkPhoneConfirmInput>,
    ): Promise<LinkPhoneConfirmResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const payload = getTypedPayload(context)
        const result = await authService.confirmPhoneLink(userId, payload, {
            ipAddress: context.httpData.ip ?? '',
            sessionId: getSessionIdForPhoneBoundFlow(context, 'confirmPhoneLink'),
            presentedSessionToken: context.auth.getPresentedUserToken(),
        })
        return respond(context, result)
    },

    async startEmailLink(
        context: HttpContext<LinkEmailStartInput>,
    ): Promise<LinkEmailStartResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const payload = getTypedPayload(context)
        const result = await authService.startEmailLink(
            userId,
            payload,
            context.auth.getPresentedUserToken(),
        )
        return respond(context, result)
    },
}
