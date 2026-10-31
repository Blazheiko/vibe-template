import logger from '#vendor/utils/logger.js'
import { maskTokenForLogs } from '#vendor/utils/helpers/mask-sensitive.js'
import crypto from 'node:crypto'
import appConfig from '#config/app.js'

const SECRET_KEY = appConfig.key ?? ''

// CRITICAL: Validate SECRET_KEY on application startup
if (SECRET_KEY.length < 32) {
    logger.error('SECURITY ERROR: APP_KEY is not set or too short (minimum 32 characters required)')
    logger.error('Please set a strong APP_KEY in your environment variables')
    logger.error('Example: APP_KEY=$(openssl rand -hex 32)')
    throw new Error('APP_KEY must be set and at least 32 characters long for security')
}

if (SECRET_KEY === 'your-secret-key' || SECRET_KEY === 'change-me') {
    logger.error('SECURITY ERROR: APP_KEY is using default/weak value')
    throw new Error('APP_KEY must be changed from default value')
}

logger.info('✓ APP_KEY validation passed')

const SIGNATURE_LENGTH = 32

const createSignature = (data: string): string => {
    return crypto
        .createHmac('sha256', SECRET_KEY)
        .update(data)
        .digest('hex')
        .substring(0, SIGNATURE_LENGTH)
}

const createSignedToken = (data: string): string => {
    const signature = createSignature(data)
    const signedToken = `${data}.${signature}`
    return Buffer.from(signedToken).toString('base64')
}

const verifySignature = (data: string, signature: string): boolean => {
    try {
        const expectedSignature = createSignature(data)

        if (signature.length !== expectedSignature.length) {
            return false
        }

        return crypto.timingSafeEqual(
            Buffer.from(signature, 'hex'),
            Buffer.from(expectedSignature, 'hex'),
        )
    } catch {
        return false
    }
}

const verifySignedToken = (
    token: string,
): { cookieUserToken: string; sessionId: string } | null => {
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8')
        const parts = decoded.split('.')

        if (parts.length !== 3) {
            logger.warn('Invalid token format: expected 3 parts')
            return null
        }

        const [cookieUserToken, sessionId, signature] = parts

        if (
            cookieUserToken === undefined ||
            cookieUserToken === '' ||
            sessionId === undefined ||
            sessionId === '' ||
            signature === undefined ||
            signature === ''
        ) {
            logger.warn('Invalid token format: missing parts')
            return null
        }

        if (!verifySignature(`${cookieUserToken}.${sessionId}`, signature)) {
            logger.warn(
                { cookieUserToken: maskTokenForLogs(cookieUserToken), sessionId },
                'Invalid token signature',
            )
            return null
        }

        return { cookieUserToken, sessionId }
    } catch (error) {
        logger.error({ err: error }, 'Token verification error:')
        return null
    }
}

// Anonymous session held in the cookie itself (feat-057). The `anon-v1` prefix keeps
// its signatures apart from session cookies (`<userToken>.<sessionId>`): neither kind
// verifies as the other.
const ANON_PREFIX = 'anon-v1'

export interface AnonSessionClaims {
    sessionId: string
    csrfToken: string
    /** Unix seconds when the cookie was issued; covered by the signature. */
    issuedAt: number
}

const anonData = ({ sessionId, csrfToken, issuedAt }: AnonSessionClaims): string =>
    `${ANON_PREFIX}.${sessionId}.${csrfToken}.${String(issuedAt)}`

const createAnonSessionToken = (claims: AnonSessionClaims): string =>
    createSignedToken(anonData(claims))

/** Claims of a well-signed anonymous cookie, or null (any other cookie included). */
const verifyAnonSessionToken = (token: string): AnonSessionClaims | null => {
    const parts = Buffer.from(token, 'base64').toString('utf-8').split('.')
    if (parts.length !== 5 || parts[0] !== ANON_PREFIX) return null
    const [, sessionId = '', csrfToken = '', issuedAtRaw = '', signature = ''] = parts
    if (!/^\d{1,12}$/.test(issuedAtRaw)) return null
    const issuedAt = Number(issuedAtRaw)
    const claims = { sessionId, csrfToken, issuedAt }
    if (sessionId === '' || csrfToken === '' || !verifySignature(anonData(claims), signature)) {
        logger.warn({ sessionId }, 'Invalid anonymous session signature')
        return null
    }
    return claims
}

export { createSignedToken, verifySignedToken, createAnonSessionToken, verifyAnonSessionToken }
