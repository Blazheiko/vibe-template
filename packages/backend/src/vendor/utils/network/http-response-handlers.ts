import { STATUS_CODES } from 'node:http'
import type { ErrorCode } from 'shared/errors'
import type { Cookie, Header } from '#vendor/types/types.js'
import type { HttpResponse } from '#vendor/start/server.js'
import cspConfig from '#config/csp.js'
import { hasCspHeader, resolveCspHeaders, type CspKind } from '#vendor/utils/network/csp.js'

const DEFAULT_SECURITY_HEADERS: readonly Header[] = [
    { name: 'x-content-type-options', value: 'nosniff' },
    { name: 'x-frame-options', value: 'DENY' },
    { name: 'referrer-policy', value: 'no-referrer' },
    {
        name: 'strict-transport-security',
        value: 'max-age=31536000; includeSubDomains',
    },
]

// Resolved once at startup: one mode (disabled / enforcing / report-only) for every response type.
const CSP_HEADERS = resolveCspHeaders(cspConfig)

const hasHeader = (headers: Header[], name: string): boolean =>
    headers.some((header) => header.name.toLowerCase() === name)

export const getHttpStatusLine = (statusCode: number | string): string => {
    const code = typeof statusCode === 'number' ? statusCode : Number.parseInt(statusCode, 10)
    const reasonPhrase = STATUS_CODES[code]

    if (reasonPhrase === undefined || reasonPhrase === '') {
        return String(statusCode)
    }

    return `${String(code)} ${reasonPhrase}`
}

// Codes come from the shared ErrorCode contract: the frontend only accepts known
// codes. 403 stays `forbidden` — a CSRF rejection can't be told apart by status.
const STATUS_ERROR_CODES: Readonly<Record<number, ErrorCode>> = {
    400: 'bad_request',
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not_found',
    409: 'conflict',
    413: 'payload_too_large',
    415: 'unsupported_media_type',
    422: 'validation_failed',
    429: 'rate_limited',
    502: 'upstream_error',
    503: 'service_unavailable',
    504: 'upstream_timeout',
}

export interface StatusErrorBody {
    status: 'error'
    code: ErrorCode
    message: string
}

// Canonical error body for a 4xx/5xx response whose payload is empty.
export const buildStatusErrorBody = (statusCode: number): StatusErrorBody => {
    const code =
        STATUS_ERROR_CODES[statusCode] ?? (statusCode >= 500 ? 'internal_error' : 'bad_request')
    const reasonPhrase = STATUS_CODES[statusCode]
    const message = reasonPhrase === undefined || reasonPhrase === '' ? 'Error' : reasonPhrase
    return { status: 'error', code, message }
}

export const writeHttpStatus = (
    res: Pick<HttpResponse, 'writeStatus'>,
    statusCode: number | string,
): void => {
    res.writeStatus(getHttpStatusLine(statusCode))
}

export const setHeaders = (
    res: HttpResponse,
    headers: Header[],
    // Lower-case header names to leave out.
    skip?: readonly string[],
): void => {
    headers.forEach((header) => {
        if (skip?.includes(header.name.toLowerCase()) === true) return
        res.writeHeader(header.name, header.value)
    })
}

/**
 * `headers` are the ones the caller writes itself; a controller-provided CSP (either
 * header name) replaces the global one. `cspKind` picks the global policy; `null`
 * writes none (assets such as the service worker script, whose CSP would apply to
 * the worker itself).
 */
export const setSecurityHeaders = (
    res: HttpResponse,
    headers: Header[] = [],
    cspKind: CspKind | null = 'strict',
): void => {
    DEFAULT_SECURITY_HEADERS.forEach((header) => {
        if (!hasHeader(headers, header.name)) {
            res.writeHeader(header.name, header.value)
        }
    })
    const csp = cspKind === null ? null : CSP_HEADERS[cspKind]
    if (csp !== null && !hasCspHeader(headers)) {
        res.writeHeader(csp.name, csp.value)
    }
}

// API responses carry session and personal data: no browser or proxy cache unless
// the controller chose a policy itself (code-issues item 42). Static files set
// their own Cache-Control in static-server.ts.
export const setApiCacheHeader = (res: HttpResponse, headers: Header[] = []): void => {
    if (!hasHeader(headers, 'cache-control')) {
        res.writeHeader('Cache-Control', 'no-store')
    }
}

/*  example responseData.cookies
|[
|  {
|      name: 'cookieOne',
|      value: 'valueOne',
|      path: '/',
|      httpOnly: true,
|      secure: true,
|      expires:
|      maxAge: 3600, // Max-Age in seconds
|   },
|]
 */
export const setCookies = (res: HttpResponse, cookies: ReadonlyMap<string, Cookie>): void => {
    for (const cookie of cookies.values()) {
        const cookieHeader = `${cookie.name}=${encodeURIComponent(cookie.value)}`
        const pathPart = cookie.path !== undefined ? `; Path=${cookie.path}` : ''
        const expiresPart =
            cookie.expires !== undefined ? `; Expires=${cookie.expires.toUTCString()}` : ''
        const httpOnlyPart = cookie.httpOnly === true ? '; HttpOnly' : ''
        const securePart = cookie.secure === true ? '; Secure' : ''
        const maxAgePart = cookie.maxAge !== undefined ? `; Max-Age=${String(cookie.maxAge)}` : ''
        const sameSitePart = cookie.sameSite !== undefined ? `; SameSite=${cookie.sameSite}` : ''

        res.writeHeader(
            'Set-Cookie',
            `${cookieHeader}${pathPart}${expiresPart}${httpOnlyPart}${securePart}${maxAgePart}${sameSitePart}`,
        )
    }
}
