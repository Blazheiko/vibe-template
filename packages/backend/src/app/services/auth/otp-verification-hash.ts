import appConfig from '#config/app.js'
import { authConfig } from '#config/auth.js'
import { hashOtpCode, otpCodeMatches, type OtpCode, type OtpHash } from '#app/domain/secrets.js'

/** The HMAC key of OTP and recovery codes: AUTH_OTP_HMAC_KEY, else APP_KEY. */
export function otpHashKey(): string {
    const configuredSecret = authConfig.otpHmacKey?.trim()
    const appSecret = appConfig.key?.trim()

    if (configuredSecret !== undefined && configuredSecret !== '') {
        return configuredSecret
    }

    if (appSecret !== undefined && appSecret !== '') {
        return appSecret
    }

    throw new Error(
        'OTP verification hashing secret is not configured. Set AUTH_OTP_HMAC_KEY or APP_KEY.',
    )
}

export function hashOtpVerificationCode(code: OtpCode): OtpHash {
    return hashOtpCode(otpHashKey(), code)
}

export function verifyOtpVerificationCode(code: OtpCode, expectedHash: OtpHash): boolean {
    return otpCodeMatches(otpHashKey(), code, expectedHash)
}
