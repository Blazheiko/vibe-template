import { createEnvReader } from '#vendor/utils/env/env-reader.js'

const reader = createEnvReader()

const rawFakeSmsCode = process.env['AUTH_FAKE_SMS_CODE']

export const authConfig = {
    strictRegistration: reader.bool('AUTH_STRICT_REGISTRATION', true),
    phoneAuthEnabled: reader.bool('AUTH_PHONE_ENABLED', false),
    otpHmacKey: process.env['AUTH_OTP_HMAC_KEY'],
    smsChallengeTtlSeconds: reader.int('AUTH_SMS_CHALLENGE_TTL_SECONDS', 10 * 60, { min: 1 }),
    smsResendCooldownSeconds: reader.int('AUTH_SMS_RESEND_COOLDOWN_SECONDS', 60, { min: 0 }),
    smsMaxInvalidAttempts: reader.int('AUTH_SMS_MAX_INVALID_ATTEMPTS', 5, { min: 0 }),
    smsMaxConfirmAttemptsPerIpPerHour: reader.int(
        'AUTH_SMS_MAX_CONFIRM_ATTEMPTS_PER_IP_PER_HOUR',
        20,
        { min: 0 },
    ),
    smsMaxSendsPerPhonePerHour: reader.int('AUTH_SMS_MAX_SENDS_PER_PHONE_PER_HOUR', 3, { min: 0 }),
    smsMaxSendsPerIpPerHour: reader.int('AUTH_SMS_MAX_SENDS_PER_IP_PER_HOUR', 10, { min: 0 }),
    emailRegisterMaxAttemptsPerEmailPerHour: reader.int(
        'AUTH_EMAIL_REGISTER_MAX_ATTEMPTS_PER_EMAIL_PER_HOUR',
        3,
        { min: 0 },
    ),
    emailRegisterMaxAttemptsPerIpPerHour: reader.int(
        'AUTH_EMAIL_REGISTER_MAX_ATTEMPTS_PER_IP_PER_HOUR',
        10,
        { min: 0 },
    ),
    emailLinkMaxAttemptsPerTargetPerHour: reader.int(
        'AUTH_EMAIL_LINK_MAX_ATTEMPTS_PER_TARGET_PER_HOUR',
        3,
        { min: 0 },
    ),
    emailLinkMaxAttemptsPerUserPerHour: reader.int(
        'AUTH_EMAIL_LINK_MAX_ATTEMPTS_PER_USER_PER_HOUR',
        3,
        { min: 0 },
    ),
    emailLinkCooldownSeconds: reader.int('AUTH_EMAIL_LINK_COOLDOWN_SECONDS', 60, { min: 0 }),
    smsProvider: process.env['AUTH_SMS_PROVIDER'] ?? 'unsupported',
    allowFakeSmsProvider: reader.bool('AUTH_SMS_PROVIDER_ALLOW_FAKE', false),
    fakeSmsCode: rawFakeSmsCode ?? '123456',
    fakeSmsCodeExplicitlySet: rawFakeSmsCode !== undefined && rawFakeSmsCode.trim() !== '',
    /** Every unreadable AUTH_* number or flag, or `null`; `validateRuntimeConfig` throws on it. */
    configError: reader.error,
} as const
