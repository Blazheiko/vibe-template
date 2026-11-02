import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_ENV = { ...process.env }

function restoreEnv(): void {
    for (const key of Object.keys(process.env)) {
        if (!(key in ORIGINAL_ENV)) {
            delete process.env[key]
        }
    }

    Object.assign(process.env, ORIGINAL_ENV)
}

// Production-like cases below need a CSRF allowlist to get past the CSRF check.
beforeEach(() => {
    process.env['CSRF_ALLOWED_ORIGINS'] = 'https://app.test'
})

afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    restoreEnv()
})

describe('validateRuntimeConfig', () => {
    it('allows unsupported provider by default', async () => {
        delete process.env['AUTH_SMS_PROVIDER']
        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).not.toThrow()
    })

    it('rejects phone auth when neither AUTH_OTP_HMAC_KEY nor APP_KEY is configured', async () => {
        process.env['AUTH_PHONE_ENABLED'] = 'true'
        delete process.env['AUTH_OTP_HMAC_KEY']
        delete process.env['APP_KEY']

        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).toThrow('Phone authentication requires AUTH_OTP_HMAC_KEY or APP_KEY for OTP hashing')
    })

    it('rejects short OTP hashing secrets for phone auth', async () => {
        process.env['AUTH_PHONE_ENABLED'] = 'true'
        process.env['AUTH_OTP_HMAC_KEY'] = 'short-secret'

        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).toThrow(
            'Phone authentication requires AUTH_OTP_HMAC_KEY or APP_KEY to be at least 32 characters long',
        )
    })

    it('allows phone auth when AUTH_OTP_HMAC_KEY is explicitly configured', async () => {
        process.env['AUTH_PHONE_ENABLED'] = 'true'
        process.env['AUTH_OTP_HMAC_KEY'] = 'c'.repeat(32)

        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).not.toThrow()
    })

    it('rejects fake provider without explicit allow flag', async () => {
        process.env['AUTH_SMS_PROVIDER'] = 'fake'
        process.env['AUTH_FAKE_SMS_CODE'] = '654321'
        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).toThrow('AUTH_SMS_PROVIDER=fake requires AUTH_SMS_PROVIDER_ALLOW_FAKE=true')
    })

    it('rejects fake provider in production-like environments even when allow flag is set', async () => {
        process.env['AUTH_SMS_PROVIDER'] = 'fake'
        process.env['AUTH_SMS_PROVIDER_ALLOW_FAKE'] = 'true'
        process.env['AUTH_FAKE_SMS_CODE'] = '654321'
        process.env['APP_ENV'] = 'prod'
        process.env['SESSION_COOKIE_HOST_PREFIX'] = 'false'
        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).toThrow('AUTH_SMS_PROVIDER=fake is forbidden in production-like environments')
    })

    it('rejects fake provider when AUTH_FAKE_SMS_CODE is not explicitly set', async () => {
        process.env['AUTH_SMS_PROVIDER'] = 'fake'
        process.env['AUTH_SMS_PROVIDER_ALLOW_FAKE'] = 'true'
        process.env['APP_ENV'] = 'local'
        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).toThrow(
            'AUTH_FAKE_SMS_CODE must be explicitly set when AUTH_SMS_PROVIDER=fake is enabled',
        )
    })

    it('allows fake provider only with explicit allow flag, explicit code, and non-production env', async () => {
        process.env['AUTH_SMS_PROVIDER'] = 'fake'
        process.env['AUTH_SMS_PROVIDER_ALLOW_FAKE'] = 'true'
        process.env['AUTH_FAKE_SMS_CODE'] = '654321'
        process.env['APP_ENV'] = 'development'
        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).not.toThrow()
    })

    it('treats APP_IS_PRODUCTION=true as authoritative', async () => {
        process.env['AUTH_SMS_PROVIDER'] = 'fake'
        process.env['AUTH_SMS_PROVIDER_ALLOW_FAKE'] = 'true'
        process.env['AUTH_FAKE_SMS_CODE'] = '654321'
        process.env['APP_ENV'] = 'dev'
        process.env['APP_IS_PRODUCTION'] = 'true'
        process.env['SESSION_COOKIE_HOST_PREFIX'] = 'false'
        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).toThrow('AUTH_SMS_PROVIDER=fake is forbidden in production-like environments')
    })

    it('rejects SESSION_COOKIE_HOST_PREFIX=true when session cookie cannot be Secure', async () => {
        process.env['APP_ENV'] = 'local'
        process.env['SESSION_COOKIE_HOST_PREFIX'] = 'true'
        process.env['APP_URL'] = 'https://app.example.com'
        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).toThrow(
            'SESSION_COOKIE_HOST_PREFIX=true requires the session cookie to be served with Secure=true',
        )
    })

    it('rejects SESSION_COOKIE_HOST_PREFIX=true when APP_URL is not https', async () => {
        process.env['APP_ENV'] = 'prod'
        process.env['SESSION_COOKIE_HOST_PREFIX'] = 'true'
        process.env['APP_URL'] = 'http://app.example.com'
        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).toThrow('SESSION_COOKIE_HOST_PREFIX=true requires APP_URL to use https://')
    })

    it('allows SESSION_COOKIE_HOST_PREFIX=true with Secure cookie and https APP_URL', async () => {
        process.env['APP_ENV'] = 'prod'
        process.env['SESSION_COOKIE_HOST_PREFIX'] = 'true'
        process.env['APP_URL'] = 'https://app.example.com'
        delete process.env['AUTH_SMS_PROVIDER']
        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).not.toThrow()
    })
})

describe('rate limit configuration', () => {
    it.each([
        ['HTTP_GLOBAL_RATE_LIMIT_MAX', '-1'],
        ['HTTP_GLOBAL_RATE_LIMIT_MAX', '1.5'],
        ['HTTP_GLOBAL_RATE_LIMIT_MAX', 'Infinity'],
        ['HTTP_GLOBAL_RATE_LIMIT_MAX', 'abc'],
        ['HTTP_GLOBAL_RATE_LIMIT_WINDOW_MS', '0'],
        ['WS_UPGRADE_RATE_LIMIT_WINDOW_MS', '1e3'],
        ['WS_UPGRADE_RATE_LIMIT_MAX', 'NaN'],
        ['RATE_LIMIT_REDIS_TIMEOUT_MS', '0'],
        ['RATE_LIMIT_REDIS_TIMEOUT_MS', '50ms'],
    ])('rejects %s=%s at startup', async (name, value) => {
        process.env[name] = value
        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).toThrow(`Invalid rate limit configuration: ${name} must be an integer`)
    })

    it('accepts MAX=0 (disabled) and positive windows', async () => {
        process.env['HTTP_GLOBAL_RATE_LIMIT_MAX'] = '0'
        process.env['WS_UPGRADE_RATE_LIMIT_WINDOW_MS'] = '1000'
        const { default: rateLimitConfig } = await import('#config/rate-limit.js')
        expect(rateLimitConfig.configError).toBeNull()
        expect(rateLimitConfig.httpGlobal.max).toBe(0)
        expect(rateLimitConfig.wsUpgrade.windowMs).toBe(1000)
    })

    it('defaults RATE_LIMIT_REDIS_TIMEOUT_MS to 50', async () => {
        delete process.env['RATE_LIMIT_REDIS_TIMEOUT_MS']
        const { default: rateLimitConfig } = await import('#config/rate-limit.js')
        expect(rateLimitConfig.redisTimeoutMs).toBe(50)
    })
})

describe('getProxyWarning', () => {
    const load = async () => (await import('./validate-runtime-config.js')).getProxyWarning()

    it('is silent outside production-like environments', async () => {
        process.env['APP_IS_PRODUCTION'] = 'false'
        process.env['TRUST_PROXY'] = 'false'
        expect(await load()).toBeNull()
    })

    it('warns in production when the proxy is not trusted', async () => {
        process.env['APP_IS_PRODUCTION'] = 'true'
        process.env['TRUST_PROXY'] = 'false'
        expect(await load()).toContain('TRUST_PROXY=false')
    })

    it('warns in production when TRUST_PROXY=true has no CIDRs', async () => {
        process.env['APP_IS_PRODUCTION'] = 'true'
        process.env['TRUST_PROXY'] = 'true'
        process.env['TRUSTED_PROXY_CIDRS'] = ''
        expect(await load()).toContain('TRUSTED_PROXY_CIDRS is empty')
    })

    it('is silent when the proxy is trusted', async () => {
        process.env['APP_IS_PRODUCTION'] = 'true'
        process.env['TRUST_PROXY'] = 'true'
        process.env['TRUSTED_PROXY_CIDRS'] = '10.0.0.0/8'
        expect(await load()).toBeNull()
    })
})

describe('Redis main client configuration', () => {
    it('uses the defaults when the variables are not set', async () => {
        delete process.env['REDIS_COMMAND_TIMEOUT_MS']
        delete process.env['REDIS_LOGOUT_ALL_DEADLINE_MS']
        const { default: redisConfig } = await import('#config/redis.js')
        expect(redisConfig.commandTimeoutMs).toBe(500)
        expect(redisConfig.logoutAllDeadlineMs).toBe(2000)
        expect(redisConfig.configError).toBeNull()
    })

    it('reads valid values', async () => {
        process.env['REDIS_COMMAND_TIMEOUT_MS'] = '250'
        process.env['REDIS_LOGOUT_ALL_DEADLINE_MS'] = '5000'
        const { default: redisConfig } = await import('#config/redis.js')
        expect(redisConfig.commandTimeoutMs).toBe(250)
        expect(redisConfig.logoutAllDeadlineMs).toBe(5000)
    })

    it.each([
        ['REDIS_COMMAND_TIMEOUT_MS', '0'],
        ['REDIS_COMMAND_TIMEOUT_MS', 'abc'],
        ['REDIS_LOGOUT_ALL_DEADLINE_MS', '-1'],
        ['REDIS_LOGOUT_ALL_DEADLINE_MS', '1.5'],
    ])('rejects %s=%s at startup', async (name, value) => {
        process.env[name] = value
        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).toThrow(`Invalid Redis configuration: ${name} must be an integer >= 1`)
    })
})

describe('CSRF startup checks', () => {
    const run = async (): Promise<string[]> => {
        const { default: logger } = await import('#logger')
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
        validateRuntimeConfig()
        return warn.mock.calls.map((call) => String(call[0]))
    }

    it('rejects a production-like start without CSRF_ALLOWED_ORIGINS', async () => {
        delete process.env['CSRF_ALLOWED_ORIGINS']
        process.env['APP_IS_PRODUCTION'] = 'true'
        process.env['SESSION_COOKIE_HOST_PREFIX'] = 'false'
        await expect(run()).rejects.toThrow(
            'Invalid CSRF configuration: CSRF_ALLOWED_ORIGINS must be set in production-like environments',
        )
    })

    it('warns when production-like runs with CSRF_ENFORCE=false', async () => {
        process.env['APP_IS_PRODUCTION'] = 'true'
        process.env['SESSION_COOKIE_HOST_PREFIX'] = 'false'
        process.env['CSRF_ENFORCE'] = 'false'
        expect(await run()).toContain(
            'CSRF_ENFORCE=false: CSRF violations are only logged, not rejected',
        )
    })

    it('warns about an empty explicit list outside production even with a fallback', async () => {
        delete process.env['CSRF_ALLOWED_ORIGINS']
        process.env['APP_ENV'] = 'local'
        process.env['APP_URL'] = 'http://localhost:5173'
        expect(await run()).toContain(
            'CSRF_ALLOWED_ORIGINS is empty: CSRF origin checks fall back to APP_URL/FRONTEND_URL (http://localhost:5173)',
        )
    })

    it('warns when neither the list nor the fallback gives an origin', async () => {
        delete process.env['CSRF_ALLOWED_ORIGINS']
        delete process.env['APP_URL']
        delete process.env['FRONTEND_URL']
        process.env['APP_ENV'] = 'local'
        expect(await run()).toContain(
            'CSRF_ALLOWED_ORIGINS is empty and APP_URL/FRONTEND_URL give no origin: CSRF origin checks accept any well-formed origin',
        )
    })

    it('stays quiet with an allowlist and enforcement on', async () => {
        process.env['APP_ENV'] = 'local'
        delete process.env['CSRF_ENFORCE']
        expect((await run()).filter((message) => message.includes('CSRF'))).toEqual([])
    })
})

describe('the daily LLM token budget (feat-063, D2)', () => {
    it('refuses to start in a production-like environment with the budget switched off', async () => {
        process.env['APP_ENV'] = 'prod'
        process.env['AI_SUPPORT_DAILY_TOKEN_BUDGET'] = '0'
        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).toThrow('AI_SUPPORT_DAILY_TOKEN_BUDGET=0 switches the LLM budget off')
    })

    it('allows the budget to be off outside production', async () => {
        process.env['APP_ENV'] = 'local'
        process.env['AI_SUPPORT_DAILY_TOKEN_BUDGET'] = '0'
        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).not.toThrow()
    })

    it('starts in production with the default budget', async () => {
        process.env['APP_ENV'] = 'prod'
        process.env['SESSION_COOKIE_HOST_PREFIX'] = 'true'
        process.env['APP_URL'] = 'https://app.example.com'
        delete process.env['AUTH_SMS_PROVIDER']
        delete process.env['AI_SUPPORT_DAILY_TOKEN_BUDGET']
        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).not.toThrow()
    })
})

describe('getDatabaseSslWarning (feat-067)', () => {
    const load = async () => (await import('./validate-runtime-config.js')).getDatabaseSslWarning()

    it('warns in a production-like environment with an unencrypted connection', async () => {
        process.env['APP_ENV'] = 'prod'
        delete process.env['PGSQL_SSL']
        expect(await load()).toContain('PGSQL_SSL=false')
    })

    it.each(['true', 'require'])('is silent in production with PGSQL_SSL=%s', async (mode) => {
        process.env['APP_ENV'] = 'prod'
        process.env['PGSQL_SSL'] = mode
        expect(await load()).toBeNull()
    })

    it('is silent outside production, where a local database is normally unencrypted', async () => {
        process.env['APP_ENV'] = 'local'
        delete process.env['PGSQL_SSL']
        expect(await load()).toBeNull()
    })

    it('is logged at startup', async () => {
        process.env['APP_ENV'] = 'prod'
        process.env['SESSION_COOKIE_HOST_PREFIX'] = 'true'
        process.env['APP_URL'] = 'https://app.example.com'
        delete process.env['AUTH_SMS_PROVIDER']
        delete process.env['PGSQL_SSL']
        const { default: logger } = await import('#logger')
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
        const { validateRuntimeConfig } = await import('./validate-runtime-config.js')

        validateRuntimeConfig()

        expect(warn.mock.calls.flat().some((m) => String(m).includes('PGSQL_SSL=false'))).toBe(true)
    })
})

// feat-082 (N): booleans and integers of the .env are read by one contract
// (documentation/backend/configuration.md): true|1|yes|on / false|0|no|off, any case; decimal
// integers in range; blank is the default; anything else stops the start and names the variable.
describe('env parsing contract', () => {
    const booleans = [
        'APP_IS_PRODUCTION',
        'SERVE_STATIC',
        'DOC_PAGE',
        'AUTH_STRICT_REGISTRATION',
        'AUTH_PHONE_ENABLED',
        'AUTH_SMS_PROVIDER_ALLOW_FAKE',
        'SMTP_ENABLED',
        'SMTP_SECURE',
        'SMTP_REQUIRE_TLS',
        'SMTP_IGNORE_TLS',
        'ENABLED_CORS',
        'CREDENTIONALS_CORS',
        'TRUST_PROXY',
        'SENTRY_ENABLED',
        'SESSION_COOKIE_HOST_PREFIX',
        'CSP_ENABLED',
        'CSP_REPORT_ONLY',
        'CSRF_ENFORCE',
        'CSRF_STRICT_ORIGIN',
        'AI_USAGE_STORE_PROMPTS',
    ]
    const integers = [
        'PORT',
        'SMTP_PORT',
        'REDIS_PORT',
        'REDIS_COMMAND_TIMEOUT_MS',
        'AUTH_SMS_CHALLENGE_TTL_SECONDS',
        'AUTH_SMS_RESEND_COOLDOWN_SECONDS',
        'AUTH_SMS_MAX_INVALID_ATTEMPTS',
        'AUTH_SMS_MAX_SENDS_PER_IP_PER_HOUR',
        'AUTH_EMAIL_LINK_COOLDOWN_SECONDS',
        'AUTH_LOGIN_MAX_ATTEMPTS_PER_IP',
        'AI_REQUEST_TIMEOUT_MS',
        'PROMPT_CACHE_TTL_MS',
        'AI_SUPPORT_DAILY_TOKEN_BUDGET',
        'SUPPORT_EMBEDDING_BATCH_SIZE',
        'READINESS_CHECK_TIMEOUT_MS',
        'HTTP_GLOBAL_RATE_LIMIT_MAX',
        'WS_ADMIN_RECHECK_INTERVAL_MS',
        'SESSION_TOKEN_CHECK_TIMEOUT_MS',
    ]

    it.each(booleans)('%s=maybe stops the start and names the variable', async (name) => {
        process.env[name] = 'maybe'
        // an unknown flag is seen when the module is read, or by the validator
        const run = async (): Promise<void> => {
            const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
            validateRuntimeConfig()
        }
        await expect(run()).rejects.toThrow(new RegExp(`${name} must be one of true, 1, yes, on`))
    })

    it.each(integers)('%s=1e3 stops the start and names the variable', async (name) => {
        process.env[name] = '1e3'
        const run = async (): Promise<void> => {
            // websocket.ts throws when it is read, not through the validator
            await import('#config/websocket.js')
            const { validateRuntimeConfig } = await import('./validate-runtime-config.js')
            validateRuntimeConfig()
        }
        await expect(run()).rejects.toThrow(new RegExp(`${name} must be an integer`))
    })

    it.each(['yes', 'YES', 'on', '1', 'True'])('AUTH_PHONE_ENABLED=%s is true', async (value) => {
        process.env['AUTH_PHONE_ENABLED'] = value
        const { authConfig } = await import('#config/auth.js')
        expect(authConfig.phoneAuthEnabled).toBe(true)
        expect(authConfig.configError).toBeNull()
    })

    it.each(['no', 'NO', 'off', '0', 'False'])('AUTH_PHONE_ENABLED=%s is false', async (value) => {
        process.env['AUTH_PHONE_ENABLED'] = value
        const { authConfig } = await import('#config/auth.js')
        expect(authConfig.phoneAuthEnabled).toBe(false)
    })

    it.each([['AUTH_STRICT_REGISTRATION'], ['AUTH_PHONE_ENABLED']])(
        'a blank %s is the default, not an error',
        async (name) => {
            process.env[name] = '  '
            const { authConfig } = await import('#config/auth.js')
            expect(authConfig.configError).toBeNull()
        },
    )

    it('a blank number is the default, and numbers are read as decimal', async () => {
        process.env['AUTH_SMS_RESEND_COOLDOWN_SECONDS'] = ''
        process.env['AUTH_SMS_MAX_INVALID_ATTEMPTS'] = ' 7 '
        const { authConfig } = await import('#config/auth.js')
        expect(authConfig.smsResendCooldownSeconds).toBe(60)
        expect(authConfig.smsMaxInvalidAttempts).toBe(7)
    })

    it.each(['-1', '0x10', '1.5', '+3', 'ten'])(
        'PORT=%s is refused instead of falling back to 3000 silently',
        async (value) => {
            process.env['PORT'] = value
            const { default: appConfig } = await import('#config/app.js')
            expect(appConfig.configError).toContain('PORT must be an integer from 1 to 65535')
        },
    )

    it('reports every unreadable variable of a module at once', async () => {
        process.env['AUTH_PHONE_ENABLED'] = 'maybe'
        process.env['AUTH_SMS_MAX_INVALID_ATTEMPTS'] = '1e3'
        const { authConfig } = await import('#config/auth.js')
        expect(authConfig.configError).toContain('AUTH_PHONE_ENABLED must be one of')
        expect(authConfig.configError).toContain('AUTH_SMS_MAX_INVALID_ATTEMPTS must be an integer')
    })
})
