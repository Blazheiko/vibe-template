// Secrets typed by state (feat-265, ADR 0007, plan Р5): a raw secret and what is stored for it are
// different types, so a raw token cannot be looked up as a hash, a hash cannot be hashed again, and
// a recovery code is hashed only in its normalized form. Every value of these types is made here.
//
// No # imports in app/domain (plan Р3, Р10): database/schema.ts imports newSessionToken from this
// module with a relative path, and drizzle-kit loads the schema without the aliases. A hash that
// needs a server key (OTP, recovery codes, the MFA browser binding) takes the key as an argument;
// the service reads it from the config and passes it.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { nanoid } from 'nanoid'
import type { Brand } from 'shared/brand'

/** The raw one-time token of a mailed link (password reset, e-mail verification and linking). */
export type RawToken = Brand<string, 'RawToken'>
/** The SHA-256 of a one-time token, as the token tables store and look it up. */
export type TokenHash = Brand<string, 'TokenHash'>
/** The SHA-256 of the browser session that started an OAuth link (session_binding_hash). */
export type SessionBindingHash = Brand<string, 'SessionBindingHash'>
/** An SMS or verification code as the user typed it or as it was sent. */
export type OtpCode = Brand<string, 'OtpCode'>
/** The keyed hash of an OTP code (sms_auth_challenges.code_hash). */
export type OtpHash = Brand<string, 'OtpHash'>
/** A recovery code as the user typed it. */
export type RawRecoveryCode = Brand<string, 'RawRecoveryCode'>
/** A recovery code in its stored form: lower case, no separators, look-alikes mapped. */
export type NormalizedRecoveryCode = Brand<string, 'NormalizedRecoveryCode'>
/** The keyed hash of a normalized recovery code (mfa_recovery_codes.code_hash). */
export type RecoveryCodeHash = Brand<string, 'RecoveryCodeHash'>
/** The value of the mfa_bind cookie of one MFA ticket. */
export type MfaBindValue = Brand<string, 'MfaBindValue'>
/** The keyed hash of an mfa_bind value, kept in the ticket. */
export type MfaBinding = Brand<string, 'MfaBinding'>
/**
 * users.session_token: the namespace of the user's sessions in Redis (ADR 0002); rotating it
 * revokes every session.
 */
export type SessionToken = Brand<string, 'SessionToken'>
/**
 * The id of one stored session (feat-272, T30): its Redis key part and the sid of its cookie. Not
 * a secret, but text the session layer wrote, kept apart from the token it is stored under.
 */
export type SessionId = Brand<string, 'SessionId'>

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const hmac = (key: string, text: string): string =>
    createHmac('sha256', key).update(text).digest('hex')

// One-time tokens

/** A fresh one-time token: 32 random bytes, base64url. */
export const newRawToken = (): RawToken => randomBytes(32).toString('base64url') as RawToken

/** The token as a client sent it back (a link, a form). Any text may be one; the lookup decides. */
export const rawTokenOf = (text: string): RawToken => text as RawToken

export const hashToken = (token: RawToken): TokenHash => sha256(token) as TokenHash

/** The binding of an OAuth link to the browser session that started it. */
export const sessionBindingHashOf = (sessionId: string): SessionBindingHash =>
    sha256(sessionId) as SessionBindingHash

// OTP codes

/** A code as the user typed it or as it was generated. */
export const otpCodeOf = (text: string): OtpCode => text as OtpCode

export const hashOtpCode = (key: string, code: OtpCode): OtpHash => hmac(key, code) as OtpHash

/** Whether `code` is the one `expected` was made from; constant time. */
export function otpCodeMatches(key: string, code: OtpCode, expected: OtpHash): boolean {
    const actual = hashOtpCode(key, code)
    if (actual.length !== expected.length) return false
    return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
}

/**
 * What a challenge stores before its code exists (sms_auth_challenges.code_hash is NOT NULL): not
 * a hex HMAC, so no code ever matches it.
 */
export const PENDING_OTP_HASH = '__pending_sms_verification_code__' as OtpHash

/**
 * A stored OTP hash that matches no code: what a challenge keeps before its code is sent (the
 * hash of 32 random bytes nobody knows).
 */
export const unguessableOtpHash = (key: string): OtpHash =>
    hmac(key, randomBytes(32).toString('hex')) as OtpHash

// Recovery codes (feat-245): 16 characters of the Crockford base32 alphabet.

const RECOVERY_CODE_LENGTH = 16
// Crockford base32: no I, L, O, U.
const RECOVERY_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/** A fresh code, grouped by four for reading. */
export function newRecoveryCode(): RawRecoveryCode {
    const bytes = randomBytes(RECOVERY_CODE_LENGTH)
    let raw = ''
    for (const byte of bytes) raw += RECOVERY_ALPHABET[byte & 31] ?? '0'
    return (raw.match(/.{4}/g)?.join('-') ?? raw) as RawRecoveryCode
}

export const rawRecoveryCodeOf = (text: string): RawRecoveryCode => text as RawRecoveryCode

/**
 * What the user typed, as the stored form: case, spaces and hyphens ignored, the Crockford look-
 * alikes mapped (i, l → 1; o → 0). Null when it cannot be a code.
 */
export function normalizeRecoveryCode(input: RawRecoveryCode): NormalizedRecoveryCode | null {
    const compact = input
        .toLowerCase()
        .replace(/[\s-]/g, '')
        .replace(/[il]/g, '1')
        .replace(/o/g, '0')
    if (compact.length !== RECOVERY_CODE_LENGTH) return null
    for (const char of compact) if (!RECOVERY_ALPHABET.includes(char)) return null
    return compact as NormalizedRecoveryCode
}

/** The stored hash of a recovery code: the OTP HMAC of the code under its own prefix. */
export const hashRecoveryCode = (key: string, code: NormalizedRecoveryCode): RecoveryCodeHash =>
    hmac(key, `mfa-recovery:${code}`) as RecoveryCodeHash

// The MFA browser binding (feat-257)

/** A new value of the binding cookie, one per ticket. */
export const newMfaBindValue = (): MfaBindValue =>
    randomBytes(32).toString('base64url') as MfaBindValue

/** The cookie value as the browser sent it back. */
export const mfaBindValueOf = (text: string): MfaBindValue => text as MfaBindValue

export const mfaBindingOf = (key: string, value: MfaBindValue): MfaBinding =>
    createHmac('sha256', key).update(`mfa-bind:${value}`).digest('base64url') as MfaBinding

// Session tokens

/** A new users.session_token (the column default, and every rotation). */
export const newSessionToken = (): SessionToken => nanoid<SessionToken>()

/** A session token read from a session record or a WS token (text the app wrote). */
export const sessionTokenOf = (text: string): SessionToken => text as SessionToken

/** The id of a session the session layer handed over (`sessionInfo.id`, a WS connection). */
export const sessionIdOf = (text: string): SessionId => text as SessionId

/** The session token a request presented (`auth.getPresentedUserToken()`), if any. */
export const presentedSessionTokenOf = (text: string | undefined): SessionToken | undefined =>
    text === undefined ? undefined : sessionTokenOf(text)

// Ids of an MFA sign-in (feat-245, feat-256): random text kept in Redis, never row ids. Each is a
// brand of its own, so the ticket id, the id of a reservation, of a completion and of the
// browser's attempt do not mix up in the ticket calls that take several of them.

export type MfaTicketId = Brand<string, 'MfaTicketId'>
export type MfaReservationId = Brand<string, 'MfaReservationId'>
export type MfaCompletionId = Brand<string, 'MfaCompletionId'>
export type MfaAttemptId = Brand<string, 'MfaAttemptId'>

/** A new ticket id: 32 random bytes, base64url (the mfa_ticket cookie). */
export const newMfaTicketId = (): MfaTicketId =>
    randomBytes(32).toString('base64url') as MfaTicketId

/** The ticket id the browser sent back in its cookie. */
export const mfaTicketIdOf = (text: string): MfaTicketId => text as MfaTicketId

export const newMfaReservationId = (): MfaReservationId => nanoid<MfaReservationId>()

export const newMfaCompletionId = (): MfaCompletionId => nanoid<MfaCompletionId>()

/** A completion id the app stored (the ticket, the sign-in completion of a session). */
export const mfaCompletionIdOf = (text: string): MfaCompletionId => text as MfaCompletionId

/**
 * The browser's id of one logical attempt (sent again only with a retry), or, without one, the id
 * of the reservation the attempt makes.
 */
export const mfaAttemptIdOf = (text: string): MfaAttemptId => text as MfaAttemptId
