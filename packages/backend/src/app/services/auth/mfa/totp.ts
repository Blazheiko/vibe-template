import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { unixSecondsOf, type UnixMs } from 'shared/brand'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р7): TOTP of RFC 6238 on node:crypto, the profile
// authenticator apps support: HMAC-SHA1, 30-second steps, 6 digits, a window of one step either
// way for clock skew. The step a code matched is what the factor stores as spent.

export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6
export const TOTP_WINDOW_STEPS = 1
const SECRET_BYTES = 20

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 without padding: the form authenticator apps read. */
export function base32Encode(bytes: Buffer): string {
    let bits = 0
    let value = 0
    let output = ''
    for (const byte of bytes) {
        value = (value << 8) | byte
        bits += 8
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31] ?? ''
            bits -= 5
        }
    }
    if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31] ?? ''
    return output
}

export function base32Decode(text: string): Buffer {
    const clean = text.replace(/=+$/, '').replace(/\s/g, '').toUpperCase()
    let bits = 0
    let value = 0
    const out: number[] = []
    for (const char of clean) {
        const index = BASE32_ALPHABET.indexOf(char)
        if (index === -1) throw new Error('invalid base32')
        value = (value << 5) | index
        bits += 5
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255)
            bits -= 8
        }
    }
    return Buffer.from(out)
}

export const generateTotpSecret = (): Buffer => randomBytes(SECRET_BYTES)

/** The TOTP step of an instant (feat-271, plan Р7: an instant, rounded down to whole seconds). */
export const totpStepAt = (at: UnixMs): bigint =>
    BigInt(Math.floor(unixSecondsOf(at) / TOTP_PERIOD_SECONDS))

/** HOTP (RFC 4226) of `counter`: what a TOTP code is for one step. */
export function hotp(
    secret: Buffer,
    counter: bigint,
    digits = TOTP_DIGITS,
    algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1',
): string {
    const message = Buffer.alloc(8)
    message.writeBigUInt64BE(counter)
    const digest = createHmac(algorithm, secret).update(message).digest()
    const offset = (digest[digest.length - 1] ?? 0) & 0x0f
    const binary =
        (((digest[offset] ?? 0) & 0x7f) << 24) |
        (((digest[offset + 1] ?? 0) & 0xff) << 16) |
        (((digest[offset + 2] ?? 0) & 0xff) << 8) |
        ((digest[offset + 3] ?? 0) & 0xff)
    return String(binary % 10 ** digits).padStart(digits, '0')
}

const sameCode = (a: string, b: string): boolean =>
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/**
 * The step `code` is valid for around `nowMs` (± TOTP_WINDOW_STEPS), or null. Every step of the
 * window is computed, so the time taken does not tell which one matched.
 */
export function matchTotpStep(secret: Buffer, code: string, nowMs: UnixMs): bigint | null {
    const clean = code.replace(/\s/g, '')
    if (!/^\d{6}$/.test(clean)) return null
    const current = totpStepAt(nowMs)
    let matched: bigint | null = null
    for (let offset = -TOTP_WINDOW_STEPS; offset <= TOTP_WINDOW_STEPS; offset++) {
        const step = current + BigInt(offset)
        if (step < 0n) continue
        if (sameCode(hotp(secret, step), clean) && matched === null) matched = step
    }
    return matched
}

/** otpauth://totp/<issuer>:<account>?secret=…&issuer=…: what the QR code of the setup carries. */
export function otpauthUri(secret: Buffer, issuer: string, account: string): string {
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
    const params = new URLSearchParams({
        secret: base32Encode(secret),
        issuer,
        algorithm: 'SHA1',
        digits: String(TOTP_DIGITS),
        period: String(TOTP_PERIOD_SECONDS),
    })
    return `otpauth://totp/${label}?${params.toString()}`
}
