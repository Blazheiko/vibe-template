import { createEnvReader } from '#vendor/utils/env/env-reader.js'
import { authConfig } from '#config/auth.js'

// Registry of shared (Redis) limits for sensitive actions. Per-process limits
// that protect an instance live in route `rateLimit` and config/rate-limit.ts.
// Services pass a policy and a key; scope, limit and window come only from here.

export interface ThrottlePolicy {
    /** Part of the Redis key: auth:throttle:<scope>:<key>. */
    readonly scope: string
    /** What the caller passes as key; for docs and review. */
    readonly keyBy: 'ip' | 'email' | 'phone' | 'identifier' | 'user'
    readonly algorithm: 'fixed-window' | 'sliding-log'
    /** 0 disables the policy, allowed only when `disableable` is true. */
    readonly limit: number
    /** The only window unit in the registry. */
    readonly windowMs: number
    readonly disableable?: boolean
    /** reject: fail the request; skip: rely on the local level that already ran. */
    readonly onRedisError: 'reject' | 'skip'
    /** Reset the counter after a successful operation. */
    readonly resetOnSuccess?: boolean
}

const HOUR_MS = 3_600_000
const reader = createEnvReader()
const errors: string[] = []

const readInt = (name: string, fallback: number, min = 1): number =>
    reader.int(name, fallback, { min })

const fixedWindow = (
    scope: string,
    keyBy: ThrottlePolicy['keyBy'],
    limit: number,
    windowMs: number,
): ThrottlePolicy => ({
    scope,
    keyBy,
    algorithm: 'fixed-window',
    limit,
    windowMs,
    onRedisError: 'reject',
})

export const throttlePolicies = {
    registerEmailIp: fixedWindow(
        'register_email_ip',
        'ip',
        authConfig.emailRegisterMaxAttemptsPerIpPerHour,
        HOUR_MS,
    ),
    registerEmailIdentifier: fixedWindow(
        'register_email_identifier',
        'email',
        authConfig.emailRegisterMaxAttemptsPerEmailPerHour,
        HOUR_MS,
    ),
    registerPhoneIp: fixedWindow(
        'register_phone_ip',
        'ip',
        authConfig.smsMaxSendsPerIpPerHour,
        HOUR_MS,
    ),
    /** One per-phone SMS bucket across register, reset and link flows. */
    smsSendPhone: fixedWindow(
        'sms_send_phone',
        'phone',
        authConfig.smsMaxSendsPerPhonePerHour,
        HOUR_MS,
    ),
    confirmPhoneIp: fixedWindow(
        'confirm_phone_ip',
        'ip',
        authConfig.smsMaxConfirmAttemptsPerIpPerHour,
        HOUR_MS,
    ),
    resetPhoneIp: fixedWindow('reset_phone_ip', 'ip', authConfig.smsMaxSendsPerIpPerHour, HOUR_MS),
    confirmResetPhoneIp: fixedWindow(
        'confirm_reset_phone_ip',
        'ip',
        authConfig.smsMaxConfirmAttemptsPerIpPerHour,
        HOUR_MS,
    ),
    linkPhoneIp: fixedWindow('link_phone_ip', 'ip', authConfig.smsMaxSendsPerIpPerHour, HOUR_MS),
    confirmLinkPhoneIp: fixedWindow(
        'confirm_link_phone_ip',
        'ip',
        authConfig.smsMaxConfirmAttemptsPerIpPerHour,
        HOUR_MS,
    ),
    linkEmailTarget: fixedWindow(
        'link_email_target',
        'email',
        authConfig.emailLinkMaxAttemptsPerTargetPerHour,
        HOUR_MS,
    ),
    linkEmailUser: fixedWindow(
        'link_email_user',
        'user',
        authConfig.emailLinkMaxAttemptsPerUserPerHour,
        HOUR_MS,
    ),
    linkEmailUserCooldown: fixedWindow(
        'link_email_user_cooldown',
        'user',
        1,
        authConfig.emailLinkCooldownSeconds * 1000,
    ),
    /**
     * Login: every admitted attempt is consumed atomically before the user
     * lookup, so concurrent requests cannot all pass a free budget.
     */
    loginIp: {
        scope: 'login_ip',
        keyBy: 'ip',
        algorithm: 'fixed-window',
        limit: readInt('AUTH_LOGIN_MAX_ATTEMPTS_PER_IP', 20),
        windowMs: readInt('AUTH_LOGIN_WINDOW_SECONDS', 900) * 1000,
        onRedisError: 'reject',
    },
    /** Higher than loginIp, so one attacker cannot easily lock out an account. */
    loginIdentifier: {
        scope: 'login_identifier',
        keyBy: 'identifier',
        algorithm: 'fixed-window',
        limit: readInt('AUTH_LOGIN_MAX_ATTEMPTS_PER_IDENTIFIER', 40),
        windowMs: readInt('AUTH_LOGIN_WINDOW_SECONDS', 900) * 1000,
        onRedisError: 'reject',
        resetOnSuccess: true,
    },
    /** Checking the current password: consumed before validatePassword. */
    changePasswordUser: {
        scope: 'change_password_user',
        keyBy: 'user',
        algorithm: 'fixed-window',
        limit: readInt('AUTH_CHANGE_PASSWORD_MAX_ATTEMPTS_PER_USER', 10),
        windowMs: readInt('AUTH_CHANGE_PASSWORD_WINDOW_SECONDS', 900) * 1000,
        onRedisError: 'reject',
        resetOnSuccess: true,
    },
    forgotPasswordIp: fixedWindow(
        'forgot_password_ip',
        'ip',
        readInt('AUTH_FORGOT_PASSWORD_MAX_REQUESTS_PER_IP_PER_HOUR', 10),
        HOUR_MS,
    ),
    forgotPasswordEmail: fixedWindow(
        'forgot_password_email',
        'email',
        readInt('AUTH_FORGOT_PASSWORD_MAX_REQUESTS_PER_EMAIL_PER_HOUR', 3),
        HOUR_MS,
    ),
    resendVerificationUser: fixedWindow(
        'resend_verification_user',
        'user',
        readInt('AUTH_RESEND_VERIFICATION_MAX_PER_USER_PER_HOUR', 3),
        HOUR_MS,
    ),
    /**
     * The verification mail sent again when the owner of an unverified account signs in with
     * the right password (the login itself answers 401). One per interval per account.
     */
    loginUnverifiedResend: fixedWindow(
        'login_unverified_resend',
        'user',
        1,
        readInt('AUTH_LOGIN_UNVERIFIED_RESEND_INTERVAL_MS', 300_000),
    ),
    /** Guessing reset tokens. */
    resetPasswordIp: fixedWindow(
        'reset_password_ip',
        'ip',
        readInt('AUTH_RESET_PASSWORD_MAX_ATTEMPTS_PER_IP_PER_HOUR', 20),
        HOUR_MS,
    ),
    /** Guessing verification tokens. */
    verifyEmailIp: fixedWindow(
        'verify_email_ip',
        'ip',
        readInt('AUTH_VERIFY_EMAIL_MAX_ATTEMPTS_PER_IP_PER_HOUR', 20),
        HOUR_MS,
    ),
    /** Support chat messages: each one costs several language-model calls (feat-063). */
    supportChatUser: fixedWindow(
        'support_chat_user',
        'user',
        readInt('SUPPORT_CHAT_USER_RATE_LIMIT_MAX', 20),
        readInt('SUPPORT_CHAT_USER_RATE_LIMIT_WINDOW_MS', 60_000),
    ),
    /** Opening the support chat (the greeting is a language-model call). */
    supportOpenChatUser: fixedWindow(
        'support_open_chat_user',
        'user',
        readInt('SUPPORT_OPEN_CHAT_USER_RATE_LIMIT_MAX', 5),
        readInt('SUPPORT_OPEN_CHAT_USER_RATE_LIMIT_WINDOW_MS', 60_000),
    ),
    /** WS upgrade level 2: cluster-wide budget after the local level 1. */
    wsUpgradeShared: {
        scope: 'upgrade',
        keyBy: 'ip',
        algorithm: 'sliding-log',
        limit: readInt('WS_UPGRADE_SHARED_RATE_LIMIT_MAX', 60, 0),
        windowMs: readInt('WS_UPGRADE_SHARED_RATE_LIMIT_WINDOW_MS', 60_000),
        disableable: true,
        onRedisError: 'skip',
    },
} as const satisfies Record<string, ThrottlePolicy>

export type ThrottlePolicyName = keyof typeof throttlePolicies

/** Registry-level checks: unique scopes, valid limits and windows. */
export const validateThrottlePolicies = (
    policies: Readonly<Record<string, ThrottlePolicy>>,
): string[] => {
    const problems: string[] = []
    const scopes = new Set<string>()
    for (const [name, policy] of Object.entries(policies)) {
        if (scopes.has(policy.scope)) {
            problems.push(`${name}: duplicate scope "${policy.scope}"`)
        }
        scopes.add(policy.scope)
        const minLimit = policy.disableable === true ? 0 : 1
        if (!Number.isSafeInteger(policy.limit) || policy.limit < minLimit) {
            problems.push(
                `${name}: limit must be an integer >= ${String(minLimit)}, got ${String(policy.limit)}`,
            )
        }
        if (!Number.isSafeInteger(policy.windowMs) || policy.windowMs <= 0) {
            problems.push(
                `${name}: windowMs must be a positive integer, got ${String(policy.windowMs)}`,
            )
        }
    }
    return problems
}

errors.push(...validateThrottlePolicies(throttlePolicies))

const problems = [...(reader.error === null ? [] : [reader.error]), ...errors]

export const throttlePolicyConfigError: string | null =
    problems.length > 0 ? problems.join('; ') : null
