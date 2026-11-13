import crypto from 'node:crypto'

import appConfig from '#config/app.js'
import { ANON_SESSION_NAMESPACE } from '#vendor/utils/session/session-ttl.js'

// The signature of a session cookie, as token-handler.ts makes it: HMAC-SHA256 with APP_KEY,
// hex, cut to 32 characters. Repeated here because token-handler.ts validates APP_KEY when it
// is imported, and this check is imported by the server itself; signed-in-cookie.spec.ts
// holds the two together (a cookie made there must pass here).
const SIGNATURE_LENGTH = 32

const sign = (data: string): string =>
    crypto
        .createHmac('sha256', appConfig.key ?? '')
        .update(data)
        .digest('hex')
        .substring(0, SIGNATURE_LENGTH)

/**
 * Whether the cookie is a well-signed cookie of a stored signed-in session (feat-202). One HMAC,
 * no I/O and no log line: the server asks this before it reads the body of a route that takes
 * one only from a signed-in user. It does not say the session still exists (the session
 * middleware checks that); it says the request is not anonymous, which nobody can fake without
 * the key.
 */
export const isSignedInSessionCookie = (token: string | undefined): boolean => {
    if (token === undefined || token === '') return false
    const parts = Buffer.from(token, 'base64').toString('utf-8').split('.')
    if (parts.length !== 3) return false
    const [cookieUserToken = '', sessionId = '', signature = ''] = parts
    if (cookieUserToken === '' || sessionId === '' || signature === '') return false
    // A stored anonymous session has a signed cookie of the same shape.
    if (cookieUserToken === ANON_SESSION_NAMESPACE) return false
    const expected = sign(`${cookieUserToken}.${sessionId}`)
    if (signature.length !== expected.length) return false
    try {
        return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    } catch {
        return false
    }
}
