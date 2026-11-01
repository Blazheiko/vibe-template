// Why csrf_guard rejected an unsafe request: the `reason` of a 403 `csrf_invalid`.
// Only `token_mismatch` can be fixed by fetching a fresh token; the others mean the
// request itself came from the wrong place, so a retry cannot help.
export const CsrfRejectReason = {
    OriginMismatch: 'origin_mismatch',
    TokenMismatch: 'token_mismatch',
    FetchSiteCrossSite: 'fetch_site_cross_site',
    FetchSiteInvalid: 'fetch_site_invalid',
} as const

export type CsrfRejectReason = (typeof CsrfRejectReason)[keyof typeof CsrfRejectReason]
