import type { LoginInputSchema } from '../schemas/auth/login.js'
import type { RegisterEmailInputSchema } from '../schemas/auth/register-email.js'
import type { RegisterPhoneStartInputSchema } from '../schemas/auth/register-phone-start.js'
import type { RegisterPhoneConfirmInputSchema } from '../schemas/auth/register-phone-confirm.js'
import type { RegisterPhoneCompleteInputSchema } from '../schemas/auth/register-phone-complete.js'
import type { ChangePasswordInputSchema } from '../schemas/auth/change-password.js'
import type { VerifyEmailInputSchema } from '../schemas/auth/verify-email.js'
import type { EmptyFormInputSchema } from '../schemas/common/empty-form.js'
import type {
    ChangePasswordResponse,
    LoginResponse,
    LogoutAllResponse,
    LogoutResponse,
    RegisterEmailResponse,
    RegisterPhoneCompleteResponse,
    RegisterPhoneConfirmResponse,
    RegisterPhoneStartResponse,
    ResendVerificationEmailResponse,
    VerifyEmailResponse,
} from '../responses/auth-controller.js'
import { contract } from './core.js'

type EmptyBody = typeof EmptyFormInputSchema.inferIn

// Which session a call runs in (csrfRecovery, sessionAfter) is the caller's: utils/api.ts on the
// frontend. A contract says what is sent and what comes back.
export const authContracts = {
    login: contract<typeof LoginInputSchema.inferIn, undefined, LoginResponse>()(
        'post',
        '/auth/login',
    ),
    registerEmail: contract<
        typeof RegisterEmailInputSchema.inferIn,
        undefined,
        RegisterEmailResponse
    >()('post', '/auth/register/email'),
    registerPhoneStart: contract<
        typeof RegisterPhoneStartInputSchema.inferIn,
        undefined,
        RegisterPhoneStartResponse
    >()('post', '/auth/register/phone/start'),
    registerPhoneConfirm: contract<
        typeof RegisterPhoneConfirmInputSchema.inferIn,
        undefined,
        RegisterPhoneConfirmResponse
    >()('post', '/auth/register/phone/confirm'),
    registerPhoneComplete: contract<
        typeof RegisterPhoneCompleteInputSchema.inferIn,
        undefined,
        RegisterPhoneCompleteResponse
    >()('post', '/auth/register/phone/complete-profile'),
    logout: contract<EmptyBody, undefined, LogoutResponse>()('post', '/auth/logout'),
    logoutAll: contract<EmptyBody, undefined, LogoutAllResponse>()('post', '/auth/logout-all'),
    changePassword: contract<
        typeof ChangePasswordInputSchema.inferIn,
        undefined,
        ChangePasswordResponse
    >()('post', '/auth/change-password'),
    verifyEmail: contract<typeof VerifyEmailInputSchema.inferIn, undefined, VerifyEmailResponse>()(
        'post',
        '/auth/verify-email',
    ),
    resendVerificationEmail: contract<EmptyBody, undefined, ResendVerificationEmailResponse>()(
        'post',
        '/auth/resend-verification-email',
    ),
} as const
