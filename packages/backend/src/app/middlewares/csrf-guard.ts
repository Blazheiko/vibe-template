import { CsrfRejectReason } from 'shared/errors'

import csrfConfig, { isExactOrigin } from '#config/csrf.js'
import type { HttpContext, Middleware } from '#vendor/types/types.js'
import { isValidCsrfToken } from '#vendor/utils/session/csrf-token.js'
import { safeEqual } from '#vendor/utils/helpers/safe-equal.js'

const UNSAFE_METHODS = new Set<string>(['post', 'put', 'patch', 'delete', 'del'])

// Sec-Fetch-Site values that move on to the Origin and token checks. `same-site` is
// a sibling subdomain: the allowlist decides. `none` is a user-initiated navigation.
const PASSING_FETCH_SITES = new Set<string>(['same-origin', 'same-site', 'none'])

const normalizeOrigin = (value: string): string | null => {
    try {
        return new URL(value).origin
    } catch {
        return null
    }
}

const isAllowedOrigin = (origin: string): boolean =>
    csrfConfig.effectiveAllowedOrigins.length === 0 ||
    csrfConfig.effectiveAllowedOrigins.includes(origin)

/**
 * Fetch Metadata: the browser itself says where the request came from. A missing
 * header (older browsers, non-browser clients) is left to the Origin check.
 */
const getFetchSiteViolation = (context: HttpContext): CsrfRejectReason | null => {
    const fetchSite = context.httpData.headers.get('sec-fetch-site')
    if (fetchSite === undefined || fetchSite === '') return null
    if (PASSING_FETCH_SITES.has(fetchSite)) return null
    // Frontend and API must share a site: SameSite=Lax keeps the session cookie off
    // cross-site requests anyway.
    if (fetchSite === 'cross-site') return CsrfRejectReason.FetchSiteCrossSite
    return CsrfRejectReason.FetchSiteInvalid
}

const hasOriginViolation = (context: HttpContext): boolean => {
    const origin = context.httpData.headers.get('origin')
    if (origin !== undefined && origin !== '') {
        // `null` (sandboxed iframe, file://) and malformed values never fall back to Referer.
        return !isExactOrigin(origin) || !isAllowedOrigin(origin)
    }

    const referer = context.httpData.headers.get('referer')
    if (referer !== undefined && referer !== '') {
        const refererOrigin = normalizeOrigin(referer)
        return refererOrigin === null || !isAllowedOrigin(refererOrigin)
    }

    return csrfConfig.strictOrigin
}

const safeTokenEqual = (expected: string | undefined, submitted: string | undefined): boolean => {
    if (!isValidCsrfToken(expected) || !isValidCsrfToken(submitted)) {
        return false
    }
    return safeEqual(expected, submitted)
}

const shouldContinueAfterViolation = (context: HttpContext, reason: CsrfRejectReason): boolean => {
    context.logger.warn(
        {
            reason,
            method: context.httpData.method,
            originPresent: context.httpData.headers.has('origin'),
            refererPresent: context.httpData.headers.has('referer'),
            secFetchSite: context.httpData.headers.get('sec-fetch-site') ?? null,
            hasSession: context.session.sessionInfo !== null,
            hasUser: context.auth.check(),
            csrfEnforce: csrfConfig.enforce,
        },
        'CSRF validation failed',
    )

    if (!csrfConfig.enforce) {
        return true
    }

    context.responseData.status = 403
    context.responseData.payload = {
        status: 'error',
        code: 'csrf_invalid',
        message: 'Invalid CSRF token',
        reason,
    }
    return false
}

/**
 * Each check can only reject; none of them lets a request skip the next one.
 * Order: Fetch Metadata → Origin/Referer → token. `session_web` runs first and
 * always attaches a session (an anonymous one carries a token too), so a request
 * without one means the session layer failed: it is rejected, not waved through.
 * That also covers login CSRF: an anonymous POST /auth/login needs the token.
 */
const csrfGuard: Middleware = async (
    context: HttpContext,
    next: () => Promise<void>,
): Promise<void> => {
    if (!UNSAFE_METHODS.has(context.httpData.method)) {
        await next()
        return
    }

    const fetchSiteViolation = getFetchSiteViolation(context)
    if (fetchSiteViolation !== null) {
        if (!shouldContinueAfterViolation(context, fetchSiteViolation)) return
    }

    if (hasOriginViolation(context)) {
        if (!shouldContinueAfterViolation(context, CsrfRejectReason.OriginMismatch)) return
    }

    const expectedToken = context.session.sessionInfo?.data.csrfToken
    const submittedToken = context.httpData.headers.get(csrfConfig.headerName)
    if (!safeTokenEqual(expectedToken, submittedToken)) {
        if (!shouldContinueAfterViolation(context, CsrfRejectReason.TokenMismatch)) return
    }

    await next()
}

export default csrfGuard
