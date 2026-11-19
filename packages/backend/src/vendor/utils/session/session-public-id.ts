import crypto from 'node:crypto'
import appConfig from '#config/app.js'

/**
 * feat-233 (Р5): the id the API shows for a session. The session id travels in logs, WS tokens and
 * user_online, and the API has no need for it. 22 base64url characters of HMAC-SHA256(APP_KEY,
 * sessionId), computed once when the session is created and stored with it (index, meta and the
 * record), so nothing computes it again and a rotated APP_KEY changes no stored id.
 */
export const PUBLIC_ID_LENGTH = 22

export const sessionPublicId = (sessionId: string): string =>
    crypto
        .createHmac('sha256', appConfig.key ?? '')
        .update(sessionId)
        .digest('base64url')
        .slice(0, PUBLIC_ID_LENGTH)

export const isSessionPublicId = (value: unknown): value is string =>
    typeof value === 'string' && /^[\w-]{22}$/.test(value)
