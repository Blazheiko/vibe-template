import { env } from 'node:process'

import appConfig from '#config/app.js'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р6): the relying party of the passkeys. A passkey is
// bound to its RP ID for good: changing WEBAUTHN_RP_ID later makes every registered passkey
// unusable, so a production-like environment must name it, not inherit it from a URL.

export interface ParsedWebAuthn {
    rpId: string
    rpName: string
    /** The exact origins a ceremony may come from (scheme, host and port, no path). */
    origins: string[]
    error: string | null
}

const DEV_FRONTEND_URL = 'http://localhost:5173'

const HOST_PATTERN =
    /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

const originOf = (value: string): string | null => {
    try {
        const url = new URL(value)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
        // An origin has no path, query or credentials: anything else is a mistake in the list.
        if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '') {
            return null
        }
        return url.origin
    } catch {
        return null
    }
}

const hostOf = (value: string): string | null => {
    try {
        return new URL(value).hostname
    } catch {
        return null
    }
}

/**
 * WEBAUTHN_RP_ID: a host name, the app's own host or a parent of it (never a public suffix;
 * WebAuthn checks that at the browser). Required in a production-like environment; elsewhere the
 * host of FRONTEND_URL. WEBAUTHN_ORIGINS: a comma-separated exact list; by default the origin of
 * FRONTEND_URL. A production-like list takes only https:// origins. Every origin's host must be
 * the RP ID or a subdomain of it, or the browser refuses the ceremony anyway.
 */
export function parseWebAuthnConfig(
    raw: { rpId?: string | undefined; rpName?: string | undefined; origins?: string | undefined },
    context: { isProductionLike: boolean; frontendUrl: string; appName: string },
): ParsedWebAuthn {
    const fail = (error: string): ParsedWebAuthn => ({ rpId: '', rpName: '', origins: [], error })
    // Outside production a setup without FRONTEND_URL (tests, a bare checkout) still gets the
    // frontend dev server of .env.example.
    const frontendUrl =
        context.frontendUrl === '' && !context.isProductionLike
            ? DEV_FRONTEND_URL
            : context.frontendUrl
    const namedRp = (raw.rpName ?? '').trim()
    const rpName = namedRp === '' ? context.appName : namedRp

    let rpId = (raw.rpId ?? '').trim().toLowerCase()
    if (rpId === '') {
        if (context.isProductionLike) {
            return fail('WEBAUTHN_RP_ID is required in a production-like environment')
        }
        rpId = hostOf(frontendUrl) ?? ''
    }
    if (rpId !== 'localhost' && !HOST_PATTERN.test(rpId)) {
        return fail(`WEBAUTHN_RP_ID must be a host name, got "${rpId}"`)
    }

    const listed = (raw.origins ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
    const sources = listed.length > 0 ? listed : [frontendUrl]
    const origins: string[] = []
    for (const source of sources) {
        const origin = originOf(source)
        if (origin === null) {
            return fail(`WEBAUTHN_ORIGINS: "${source}" is not an origin (scheme://host[:port])`)
        }
        if (context.isProductionLike && !origin.startsWith('https://')) {
            return fail(
                `WEBAUTHN_ORIGINS: "${origin}" must be https:// in a production-like environment`,
            )
        }
        const host = new URL(origin).hostname
        if (host !== rpId && !host.endsWith(`.${rpId}`)) {
            return fail(`WEBAUTHN_ORIGINS: "${origin}" is not on the RP ID "${rpId}" or below it`)
        }
        if (!origins.includes(origin)) origins.push(origin)
    }
    return { rpId, rpName, origins, error: null }
}

const parsed = parseWebAuthnConfig(
    {
        rpId: env['WEBAUTHN_RP_ID'],
        rpName: env['WEBAUTHN_RP_NAME'],
        origins: env['WEBAUTHN_ORIGINS'],
    },
    {
        isProductionLike: appConfig.isProductionLike,
        frontendUrl: appConfig.frontendUrl,
        appName: appConfig.appName,
    },
)

export default Object.freeze({
    rpId: parsed.rpId,
    rpName: parsed.rpName,
    origins: Object.freeze([...parsed.origins]),
    /** A registration or a sign-in ceremony stays answerable this long, in seconds. */
    challengeTtlSeconds: 300,
    /** At most this many passkeys per account. */
    maxPasskeysPerUser: 20,
    configError: parsed.error,
})
