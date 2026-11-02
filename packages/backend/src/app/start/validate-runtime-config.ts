import aiConfig from '#config/ai.js'
import supportConfig from '#config/support.js'
import loggingConfig from '#config/logging.js'
import responseValidationConfig from '#config/response-validation.js'
import healthConfig from '#config/health.js'
import appConfig from '#config/app.js'
import databaseConfig from '#config/database.js'
import { authConfig } from '#config/auth.js'
import mailConfig from '#config/mail.js'
import corsConfig from '#config/cors.js'
import sentryConfig from '#config/sentry.js'
import cspConfig from '#config/csp.js'
import csrfConfig from '#config/csrf.js'
import { networkConfig } from '#config/network.js'
import rateLimitConfig from '#config/rate-limit.js'
import redisConfig from '#config/redis.js'
import { throttlePolicyConfigError } from '#config/throttle-policies.js'
import sessionConfig from '#config/session.js'
import logger from '#logger'
import { nonEmpty } from '#vendor/utils/env/non-empty.js'

/** Per-IP limits are only as good as the client IP: warn when it is the proxy's. */
export function getProxyWarning(): string | null {
    if (!appConfig.isProductionLike) return null
    if (!networkConfig.trustProxy) {
        return 'TRUST_PROXY=false: behind a reverse proxy every client shares the proxy IP and one rate-limit budget'
    }
    if (networkConfig.trustedProxyCidrs.length === 0) {
        return 'TRUST_PROXY=true but TRUSTED_PROXY_CIDRS is empty: no proxy is trusted, so behind a proxy every client shares one rate-limit budget'
    }
    return null
}

/** A production-like environment should not talk to its database in the clear. */
export function getDatabaseSslWarning(): string | null {
    if (!appConfig.isProductionLike || databaseConfig.ssl !== 'false') return null
    return 'PGSQL_SSL=false: the connection to PostgreSQL is not encrypted; use PGSQL_SSL=true (verified) or require unless the database is reachable only over a trusted private network'
}

export function validateRuntimeConfig(): void {
    // Booleans and integers of the .env, read by one contract (feat-082)
    const unreadable: [string, string | null][] = [
        ['app', appConfig.configError],
        ['auth', authConfig.configError],
        ['mail', mailConfig.configError],
        ['CORS', corsConfig.configError],
        ['network', networkConfig.configError],
        ['Sentry', sentryConfig.configError],
        ['session', sessionConfig.configError],
    ]
    for (const [area, problem] of unreadable) {
        if (problem !== null) throw new Error(`Invalid ${area} configuration: ${problem}`)
    }

    if (cspConfig.configError !== null) {
        throw new Error(`Invalid CSP configuration: ${cspConfig.configError}`)
    }

    if (rateLimitConfig.configError !== null) {
        throw new Error(`Invalid rate limit configuration: ${rateLimitConfig.configError}`)
    }

    if (redisConfig.configError !== null) {
        throw new Error(`Invalid Redis configuration: ${redisConfig.configError}`)
    }

    if (aiConfig.configError !== null) {
        throw new Error(`Invalid AI configuration: ${aiConfig.configError}`)
    }

    if (appConfig.isProductionLike && aiConfig.supportDailyTokenBudget === 0) {
        throw new Error(
            'AI_SUPPORT_DAILY_TOKEN_BUDGET=0 switches the LLM budget off, which is forbidden in production-like environments',
        )
    }

    if (healthConfig.configError !== null) {
        throw new Error(`Invalid readiness configuration: ${healthConfig.configError}`)
    }

    if (loggingConfig.configError !== null) {
        throw new Error(`Invalid logging configuration: ${loggingConfig.configError}`)
    }

    if (responseValidationConfig.configError !== null) {
        throw new Error(
            `Invalid response validation configuration: ${responseValidationConfig.configError}`,
        )
    }

    if (supportConfig.configError !== null) {
        throw new Error(`Invalid Support AI configuration: ${supportConfig.configError}`)
    }

    if (throttlePolicyConfigError !== null) {
        throw new Error(`Invalid throttle policy configuration: ${throttlePolicyConfigError}`)
    }

    if (csrfConfig.configError !== null) {
        throw new Error(`Invalid CSRF configuration: ${csrfConfig.configError}`)
    }

    for (const warning of csrfConfig.warnings) {
        logger.warn(warning)
    }

    const proxyWarning = getProxyWarning()
    if (proxyWarning !== null) {
        logger.warn(proxyWarning)
    }

    const databaseSslWarning = getDatabaseSslWarning()
    if (databaseSslWarning !== null) {
        logger.warn(databaseSslWarning)
    }

    if (sessionConfig.useHostPrefix) {
        if (!sessionConfig.cookie.secure) {
            throw new Error(
                'SESSION_COOKIE_HOST_PREFIX=true requires the session cookie to be served with Secure=true',
            )
        }
        if (!appConfig.url.startsWith('https://')) {
            throw new Error('SESSION_COOKIE_HOST_PREFIX=true requires APP_URL to use https://')
        }
    }

    if (authConfig.phoneAuthEnabled) {
        const otpHashSecret = nonEmpty(authConfig.otpHmacKey?.trim()) ?? appConfig.key?.trim() ?? ''

        if (otpHashSecret === '') {
            throw new Error(
                'Phone authentication requires AUTH_OTP_HMAC_KEY or APP_KEY for OTP hashing',
            )
        }

        if (otpHashSecret.length < 32) {
            throw new Error(
                'Phone authentication requires AUTH_OTP_HMAC_KEY or APP_KEY to be at least 32 characters long',
            )
        }
    }

    if (authConfig.smsProvider !== 'fake') {
        return
    }

    if (!authConfig.allowFakeSmsProvider) {
        throw new Error('AUTH_SMS_PROVIDER=fake requires AUTH_SMS_PROVIDER_ALLOW_FAKE=true')
    }

    if (appConfig.isProductionLike) {
        throw new Error('AUTH_SMS_PROVIDER=fake is forbidden in production-like environments')
    }

    if (!authConfig.fakeSmsCodeExplicitlySet) {
        throw new Error(
            'AUTH_FAKE_SMS_CODE must be explicitly set when AUTH_SMS_PROVIDER=fake is enabled',
        )
    }
}
