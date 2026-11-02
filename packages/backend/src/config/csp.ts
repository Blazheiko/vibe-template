import { env } from 'node:process'
import appConfig from '#config/app.js'
import { getWsUrl } from '#app/services/communication/get-ws-url-service.js'
import { createEnvReader } from '#vendor/utils/env/env-reader.js'
import {
    buildCspValue,
    buildDocumentDirectives,
    originOf,
    parseOrigin,
    parseOriginList,
    parseReportUri,
} from '#vendor/utils/network/csp.js'

const blankToNull = (value: string | undefined): string | null => {
    const trimmed = value?.trim() ?? ''
    return trimmed === '' ? null : trimmed
}

const buildDocumentPolicy = (): string => {
    const apiOverride = blankToNull(env['CSP_API_ORIGIN'])
    const wsOverride = blankToNull(env['CSP_WS_ORIGIN'])
    const sentryOrigin = blankToNull(env['CSP_SENTRY_ORIGIN'])
    const reportUri = blankToNull(env['CSP_REPORT_URI'])
    const cdnUrl = blankToNull(appConfig.cdnUrl)

    return buildCspValue(
        buildDocumentDirectives({
            isProduction: appConfig.isProductionLike,
            // Must match the frontend's VITE_BASE_URL; same-origin is already covered by 'self'.
            apiOrigin:
                apiOverride !== null
                    ? parseOrigin(apiOverride, ['http'], 'CSP_API_ORIGIN')
                    : appConfig.url !== ''
                      ? originOf(appConfig.url, ['http'], 'APP_URL')
                      : null,
            // The exact endpoint the API hands to clients, so CSP and the real WS address cannot diverge.
            wsOrigin:
                wsOverride !== null
                    ? parseOrigin(wsOverride, ['ws'], 'CSP_WS_ORIGIN')
                    : originOf(getWsUrl(), ['ws'], 'WS URL (DOMAIN / APP_ENV)'),
            sentryOrigin:
                sentryOrigin !== null
                    ? parseOrigin(sentryOrigin, ['http'], 'CSP_SENTRY_ORIGIN')
                    : null,
            // Media URLs reach the browser as CDN_URL + key (see main-service `cdnUrl`).
            mediaOrigin: cdnUrl !== null ? originOf(cdnUrl, ['http'], 'CDN_URL') : null,
            extraConnectSrc: parseOriginList(
                env['CSP_EXTRA_CONNECT_SRC'],
                ['http', 'ws'],
                'CSP_EXTRA_CONNECT_SRC',
            ),
            extraImgSrc: parseOriginList(env['CSP_EXTRA_IMG_SRC'], ['http'], 'CSP_EXTRA_IMG_SRC'),
            reportUri: reportUri !== null ? parseReportUri(reportUri, 'CSP_REPORT_URI') : null,
        }),
    )
}

// Invalid values must not crash at import time: the error is reported by
// validateRuntimeConfig() on startup, and CSP stays disabled meanwhile.
let documentPolicy = ''
let configError: string | null = null
try {
    documentPolicy = buildDocumentPolicy()
} catch (err: unknown) {
    configError = err instanceof Error ? err.message : String(err)
}

const reader = createEnvReader()
const enabled = reader.bool('CSP_ENABLED', true)
const reportOnly = reader.bool('CSP_REPORT_ONLY', false)
const problems = [configError, reader.error].filter((error) => error !== null)

export default Object.freeze({
    enabled: enabled && problems.length === 0,
    reportOnly,
    documentPolicy,
    configError: problems.length > 0 ? problems.join('; ') : null,
})
