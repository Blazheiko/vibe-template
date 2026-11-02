import { env } from 'node:process'

import appConfig from '#config/app.js'
import { createEnvReader } from '#vendor/utils/env/env-reader.js'

export interface CsrfConfig {
    enforce: boolean
    strictOrigin: boolean
    /** CSRF_ALLOWED_ORIGINS as written. */
    allowedOrigins: readonly string[]
    /**
     * What the guard compares Origin/Referer against: CSRF_ALLOWED_ORIGINS, or outside
     * production-like environments with an empty list, the origins of APP_URL and
     * FRONTEND_URL. Empty means any well-formed origin passes the list check.
     */
    effectiveAllowedOrigins: readonly string[]
    headerName: string
    configError: string | null
    warnings: readonly string[]
}

interface CsrfConfigContext {
    isProductionLike: boolean
    appUrl: string
    frontendUrl: string
}

function parseOriginsList(value: string | undefined): readonly string[] {
    if (value === undefined || value.trim() === '') return []
    return value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0)
}

/** An exact http(s) origin: no path, query or trailing slash. */
export function isExactOrigin(value: string): boolean {
    try {
        const url = new URL(value)
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
    } catch {
        return false
    }
}

function originOf(value: string): string | null {
    if (value === '') return null
    try {
        const url = new URL(value)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
        return url.origin
    } catch {
        return null
    }
}

export function buildCsrfConfig(
    source: Record<string, string | undefined>,
    context: CsrfConfigContext,
): CsrfConfig {
    const reader = createEnvReader(source)
    const enforce = reader.bool('CSRF_ENFORCE', true)
    const strictOrigin = reader.bool('CSRF_STRICT_ORIGIN', true)
    const allowedOrigins = parseOriginsList(source['CSRF_ALLOWED_ORIGINS'])
    const warnings: string[] = []
    let configError: string | null = null

    const invalid = allowedOrigins.filter((origin) => !isExactOrigin(origin))
    if (invalid.length > 0) {
        configError = `CSRF_ALLOWED_ORIGINS must list exact http(s) origins without a path or trailing slash, got ${invalid.map((origin) => `"${origin}"`).join(', ')}`
    } else if (context.isProductionLike && allowedOrigins.length === 0) {
        configError = 'CSRF_ALLOWED_ORIGINS must be set in production-like environments'
    }

    if (reader.error !== null) {
        configError = configError === null ? reader.error : `${configError}; ${reader.error}`
    }

    let effectiveAllowedOrigins = allowedOrigins
    if (allowedOrigins.length === 0 && !context.isProductionLike) {
        effectiveAllowedOrigins = [
            ...new Set(
                [originOf(context.appUrl), originOf(context.frontendUrl)].filter(
                    (origin): origin is string => origin !== null,
                ),
            ),
        ]
        warnings.push(
            effectiveAllowedOrigins.length > 0
                ? `CSRF_ALLOWED_ORIGINS is empty: CSRF origin checks fall back to APP_URL/FRONTEND_URL (${effectiveAllowedOrigins.join(', ')})`
                : 'CSRF_ALLOWED_ORIGINS is empty and APP_URL/FRONTEND_URL give no origin: CSRF origin checks accept any well-formed origin',
        )
    }

    if (context.isProductionLike && !enforce) {
        warnings.push('CSRF_ENFORCE=false: CSRF violations are only logged, not rejected')
    }

    return {
        enforce,
        strictOrigin,
        allowedOrigins,
        effectiveAllowedOrigins,
        headerName: 'x-csrf-token',
        configError,
        warnings,
    }
}

export default Object.freeze(
    buildCsrfConfig(env, {
        isProductionLike: appConfig.isProductionLike,
        appUrl: appConfig.url,
        frontendUrl: appConfig.frontendUrl,
    }),
)
