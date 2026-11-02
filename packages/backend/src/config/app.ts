import { env } from 'node:process'
import { nonEmpty } from '#vendor/utils/env/non-empty.js'
import { createEnvReader } from '#vendor/utils/env/env-reader.js'

const reader = createEnvReader()

function stripTrailingSlash(value: string): string {
    return value.endsWith('/') ? value.slice(0, -1) : value
}

function normalizePath(path: string): string {
    if (path === '') return ''
    let normalizedPath = stripTrailingSlash(path)
    if (normalizedPath.startsWith('/')) normalizedPath = normalizedPath.slice(1)
    return normalizedPath
}

function normalizeUrl(url: string | undefined): string {
    if (url === undefined) return ''
    return stripTrailingSlash(url)
}

function normalizeEnvName(value: string | undefined): string {
    return (value ?? '').trim().toLowerCase()
}

// Parse size in bytes: a positive safe integer written in digits only.
// Anything else ("Infinity", "1.5", "1e6", "0x10", "0") falls back to the default.
function parseSize(value: string | undefined, defaultValue: number): number {
    if (value === undefined) return defaultValue
    const trimmed = value.trim()
    if (!/^\d+$/.test(trimmed)) return defaultValue
    const size = Number(trimmed)
    if (!Number.isSafeInteger(size) || size <= 0) return defaultValue
    return size
}

const normalizedRuntimeEnv = normalizeEnvName(env['APP_ENV'] ?? env['NODE_ENV'])

const config = Object.freeze({
    appName: env['APP_NAME'] ?? 'uwebsockets-api',
    key: env['APP_KEY'],
    env: env['APP_ENV'],
    runtimeEnvName: normalizedRuntimeEnv,
    isProductionLike: reader.bool(
        'APP_IS_PRODUCTION',
        normalizedRuntimeEnv === 'production' || normalizedRuntimeEnv === 'prod',
    ),
    url: normalizeUrl(env['APP_URL']),
    frontendUrl: normalizeUrl(env['FRONTEND_URL'] ?? env['APP_URL']),
    landingUrl: normalizeUrl(env['LANDING_URL']),
    cdnUrl: env['CDN_URL'] ?? '',
    domain: env['DOMAIN'] ?? '127.0.0.1',
    host: env['HOST'] ?? '0.0.0.0',
    port: reader.int('PORT', 3000, { min: 1, max: 65535 }),
    pathPrefix: normalizePath(env['API_PATH_PREFIX'] ?? 'api'),
    // `APP_UNIX_PATH=` from .env.example must mean "listen on HOST:PORT", not listen_unix('')
    unixPath: nonEmpty(env['APP_UNIX_PATH']),
    // Примеры использования логических значений:
    // SERVE_STATIC=true, SERVE_STATIC=1, SERVE_STATIC=yes, SERVE_STATIC=on
    serveStatic: reader.bool('SERVE_STATIC', false),
    // DOC_PAGE=false, DOC_PAGE=0, DOC_PAGE=no, DOC_PAGE=off или не указано
    docPage: reader.bool('DOC_PAGE', false),
    characters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    reasonableCookieLimit: 10000, // Reasonable limit for cookie value
    reasonableCookieKeyLimit: 255, // Reasonable limit for cookie key length
    maxUrlLength: 2048, // Reasonable limit for url length
    accessTokenLength: 16, // Reasonable limit for access token length
    // Static files: kept in RAM up to these sizes, the rest is streamed from disk
    // (code-issues item 41).
    staticMaxMemoryFileSize: parseSize(env['STATIC_MAX_MEMORY_FILE_SIZE'], 1_048_576),
    staticMaxMemoryTotal: parseSize(env['STATIC_MAX_MEMORY_TOTAL'], 67_108_864),
    maxBodySize: parseSize(env['APP_MAX_BODY_SIZE'], 2_097_152),
    maxJsonBodySize: parseSize(env['APP_MAX_JSON_BODY_SIZE'], 2_097_152),
    maxMultipartBodySize: parseSize(env['APP_MAX_MULTIPART_BODY_SIZE'], 52_428_800),
    maxOctetStreamBodySize: parseSize(env['APP_MAX_OCTET_BODY_SIZE'], 52_428_800),
    /** Every unreadable flag or number among the variables above, or `null`. */
    configError: reader.error,
})
export default config
