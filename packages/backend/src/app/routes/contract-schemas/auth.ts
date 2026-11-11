import {
    ChangePasswordInputSchema,
    EmptyFormInputSchema,
    ForgotPasswordInputSchema,
    LinkEmailStartInputSchema,
    LinkPhoneConfirmInputSchema,
    LinkPhoneStartInputSchema,
    LoginInputSchema,
    RegisterEmailInputSchema,
    RegisterPhoneCompleteInputSchema,
    RegisterPhoneConfirmInputSchema,
    RegisterPhoneStartInputSchema,
    ResetPasswordInputSchema,
    ResetPhoneCompleteInputSchema,
    ResetPhoneStartInputSchema,
    VerifyEmailInputSchema,
} from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { authContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const authSchemas = contractSchemas(authContracts, {
    login: { body: LoginInputSchema, response: ResponseSchemas.LoginResponseSchema },
    registerEmail: {
        body: RegisterEmailInputSchema,
        response: ResponseSchemas.RegisterEmailResponseSchema,
    },
    registerPhoneStart: {
        body: RegisterPhoneStartInputSchema,
        response: ResponseSchemas.RegisterPhoneStartResponseSchema,
    },
    registerPhoneConfirm: {
        body: RegisterPhoneConfirmInputSchema,
        response: ResponseSchemas.RegisterPhoneConfirmResponseSchema,
    },
    registerPhoneComplete: {
        body: RegisterPhoneCompleteInputSchema,
        response: ResponseSchemas.RegisterPhoneCompleteResponseSchema,
    },
    logout: { body: EmptyFormInputSchema, response: ResponseSchemas.LogoutResponseSchema },
    logoutAll: { body: EmptyFormInputSchema, response: ResponseSchemas.LogoutAllResponseSchema },
    changePassword: {
        body: ChangePasswordInputSchema,
        response: ResponseSchemas.ChangePasswordResponseSchema,
    },
    verifyEmail: {
        body: VerifyEmailInputSchema,
        response: ResponseSchemas.VerifyEmailResponseSchema,
    },
    resendVerificationEmail: {
        body: EmptyFormInputSchema,
        response: ResponseSchemas.ResendVerificationEmailResponseSchema,
    },
    forgotPassword: {
        body: ForgotPasswordInputSchema,
        response: ResponseSchemas.ForgotPasswordResponseSchema,
    },
    resetPhoneStart: {
        body: ResetPhoneStartInputSchema,
        response: ResponseSchemas.ResetPhoneStartResponseSchema,
    },
    resetPhoneComplete: {
        body: ResetPhoneCompleteInputSchema,
        response: ResponseSchemas.ResetPhoneCompleteResponseSchema,
    },
    resetPassword: {
        body: ResetPasswordInputSchema,
        response: ResponseSchemas.ResetPasswordResponseSchema,
    },
    linkPhoneStart: {
        body: LinkPhoneStartInputSchema,
        response: ResponseSchemas.LinkPhoneStartResponseSchema,
    },
    linkPhoneConfirm: {
        body: LinkPhoneConfirmInputSchema,
        response: ResponseSchemas.LinkPhoneConfirmResponseSchema,
    },
    linkEmailStart: {
        body: LinkEmailStartInputSchema,
        response: ResponseSchemas.LinkEmailStartResponseSchema,
    },
})
