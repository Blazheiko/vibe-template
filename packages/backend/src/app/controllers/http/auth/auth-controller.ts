import { stepUpService } from '#app/services/auth/mfa/step-up.js'
import {
    completeSecondStep,
    secondStepPasskeyOptions,
    secondStepState,
} from '#app/services/auth/mfa/mfa-sign-in.js'
import { passkeySignIn } from '#app/services/auth/mfa/passkey-sign-in.js'
import type { HttpContext } from '#vendor/types/types.js'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { mapControllerError, respond } from '#app/controllers/shared/controller-error.js'
import { auditActorFrom, proofHolderActor } from '#app/controllers/shared/audit-actor.js'
import { requireUserId } from '#app/controllers/shared/require-user-id.js'
import { authService } from '#app/services/auth/auth-service.js'
import { Result } from 'better-result'
import type {
    ChangePasswordResponse,
    ForgotPasswordResponse,
    LoginResponse,
    MfaStateResponse,
    ReauthOptionsResponse,
    ReauthResponse,
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
    PasskeyLoginOptionsResponse,
    PasskeyChallengeResponse,
    WebAuthnRequestOptions,
} from 'shared'
import type {
    ChangePasswordInput,
    EmptyFormInput,
    ForgotPasswordInput,
    LoginInput,
    MfaVerifyInput,
    PasskeyLoginInput,
    ReauthInput,
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
import { wsSessionRevocation } from '#app/services/auth/ws-session-revocation.js'

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

    /** feat-245 (Р4): the second sign-in step against the ticket cookie. */
    async mfaVerify(context: HttpContext<MfaVerifyInput>): Promise<LoginResponse> {
        const payload = getTypedPayload(context)
        const result = await completeSecondStep(
            { auth: context.auth, session: context.session },
            payload,
            { requestId: context.requestId, logger: context.logger },
        )
        return respond(context, result)
    },

    /** feat-245 (Р4): whether this browser holds a second step (the sign-in page after a reload). */
    async mfaState(context: HttpContext<EmptyFormInput>): Promise<MfaStateResponse> {
        const result = await secondStepState({ auth: context.auth, session: context.session })
        return respond(context, result)
    },

    /** feat-246 (Р6): the options of a passwordless sign-in. */
    async passkeyOptions(
        context: HttpContext<EmptyFormInput>,
    ): Promise<PasskeyLoginOptionsResponse> {
        const result = await passkeySignIn.options()
        return respond(context, result, (value) => ({
            status: 'success' as const,
            challengeId: value.challengeId,
            // The library's JSON options; the response schema checks every field of them.
            options: value.options as WebAuthnRequestOptions,
        }))
    },

    /** feat-246 (Р6): a sign-in with a passkey alone. */
    async passkeyVerify(context: HttpContext<PasskeyLoginInput>): Promise<LoginResponse> {
        const payload = getTypedPayload(context)
        const result = await passkeySignIn.verify(
            { challengeId: payload.challengeId, response: payload.response },
            {
                auth: context.auth,
                session: context.session,
                ipAddress: context.httpData.ip ?? '',
                request: { requestId: context.requestId, logger: context.logger },
            },
        )
        return respond(context, result)
    },

    /** feat-245 (Р8): a recovery session ends like a logout. */
    async recoveryFinish(context: HttpContext<EmptyFormInput>): Promise<LogoutResponse> {
        const result = await authService.logout(context.auth, context.session)
        return respond(context, result)
    },

    async logout(context: HttpContext<EmptyFormInput>): Promise<LogoutResponse> {
        const result = await authService.logout(context.auth, context.session)
        return respond(context, result)
    },

    async logoutAll(context: HttpContext<EmptyFormInput>): Promise<LogoutAllResponse> {
        const result = await authService.logoutAll(
            context.auth,
            context.session,
            auditActorFrom(context),
        )
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
        // Before the renewal replaces it: the connections were opened from this id.
        const sessionId = context.session.sessionInfo?.id
        const result = await authService.changePassword(
            userId,
            payload,
            context.auth.getPresentedUserToken(),
            () => context.session.isStored(),
            sessionId,
            auditActorFrom(context),
            context.session.sessionInfo?.data.auth,
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
            // feat-221: the service spared this session's connections for the renewal. Without
            // one they belong to a revoked session; the client signs in again.
            if (sessionId !== undefined) {
                wsSessionRevocation.closeUserConnections(String(userId), { sessionId })
            }
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
            proofHolderActor(context, 'email_link'),
        )
        // The service's reasons (invalid_token, expired_token, used_token, token_required,
        // passwords_mismatch) pass through the canonical error body as they are.
        return respond(context, result, ({ signInMethods }) => ({
            status: 'success' as const,
            signInMethods,
        }))
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
            proofHolderActor(context, 'sms_code'),
        )
        return respond(context, result, ({ signInMethods }) => ({
            status: 'success' as const,
            message: 'Password reset successfully',
            signInMethods,
        }))
    },

    async verifyEmail(context: HttpContext<VerifyEmailInput>): Promise<VerifyEmailResponse> {
        const payload = getTypedPayload(context)
        const userId = context.auth.getUserId()
        const result = await emailVerificationService.verifyEmail(
            payload.token,
            { ipAddress: context.httpData.ip ?? '' },
            {
                userId: userId === null ? null : BigInt(userId),
                presentedSessionToken: context.auth.getPresentedUserToken(),
                ...(payload.password !== undefined ? { password: payload.password } : {}),
            },
            { requestId: context.requestId, logger: context.logger },
        )
        return respond(context, result, (value) => ({ status: 'success', message: value.message }))
    },

    async resendVerificationEmail(
        context: HttpContext<EmptyFormInput>,
    ): Promise<ResendVerificationEmailResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const result = await emailVerificationService.queueVerificationEmail(userId, () =>
            context.session.isStored(),
        )
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
            sessionStored: () => context.session.isStored(),
            sessionAuth: context.session.sessionInfo?.data.auth,
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
        const result = await authService.confirmPhoneLink(
            userId,
            payload,
            {
                ipAddress: context.httpData.ip ?? '',
                sessionId: getSessionIdForPhoneBoundFlow(context, 'confirmPhoneLink'),
                presentedSessionToken: context.auth.getPresentedUserToken(),
                sessionStored: () => context.session.isStored(),
            },
            auditActorFrom(context),
        )
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
            () => context.session.isStored(),
            context.session.sessionInfo?.data.auth,
        )
        return respond(context, result)
    },

    /** feat-245 (Р3): the step-up proofs this account can give. */
    async reauthOptions(context: HttpContext<EmptyFormInput>): Promise<ReauthOptionsResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const result = await stepUpService.options({
            userId,
            session: context.session,
            presentedSessionToken: context.auth.getPresentedUserToken(),
        })
        return respond(context, result, (value) => ({ status: 'success' as const, ...value }))
    },

    /** feat-245 (Р3): a step-up of this session. */
    async reauth(context: HttpContext<ReauthInput>): Promise<ReauthResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const payload = getTypedPayload(context)
        const result = await stepUpService.reauth(
            {
                userId,
                session: context.session,
                presentedSessionToken: context.auth.getPresentedUserToken(),
                request: { requestId: context.requestId, logger: context.logger },
            },
            {
                proof: payload.proof,
                ...(payload.password !== undefined ? { password: payload.password } : {}),
                ...(payload.code !== undefined ? { code: payload.code } : {}),
                ...(payload.response !== undefined ? { response: payload.response } : {}),
            },
        )
        return respond(context, result, () => ({ status: 'success' as const }))
    },

    /** feat-246 (Р6): the options of a passkey signature as the second sign-in step. */
    async mfaWebauthnOptions(
        context: HttpContext<EmptyFormInput>,
    ): Promise<PasskeyChallengeResponse> {
        const result = await secondStepPasskeyOptions({
            auth: context.auth,
            session: context.session,
        })
        return respond(context, result, (value) => ({
            status: 'success' as const,
            options: value.options as WebAuthnRequestOptions,
        }))
    },

    /** feat-246 (Р6): the options of a passkey signature as a step-up of this session. */
    async reauthWebauthnOptions(
        context: HttpContext<EmptyFormInput>,
    ): Promise<PasskeyChallengeResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const result = await stepUpService.passkeyOptions({
            userId,
            session: context.session,
            presentedSessionToken: context.auth.getPresentedUserToken(),
        })
        return respond(context, result, (value) => ({
            status: 'success' as const,
            options: value.options as WebAuthnRequestOptions,
        }))
    },
}
