import { randomBytes } from 'node:crypto'
import { nanoid } from 'nanoid'

import { recoveryCodeRepository } from '#app/repositories/index.js'
import type { DbExecutor } from '#app/repositories/index.js'
import { hashOtpVerificationCode } from '#app/services/auth/otp-verification-hash.js'
import type { UserId } from '#app/domain/ids.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р8): one-time recovery codes. 16 characters of the
// Crockford base32 alphabet (80 bits), shown as xxxx-xxxx-xxxx-xxxx. Stored as HMAC-SHA256 with
// AUTH_OTP_HMAC_KEY (APP_KEY when unset), like the SMS codes: the entropy makes a slow hash
// unnecessary and the check stays cheap under the per-user throttle.

export const RECOVERY_CODE_COUNT = 10
const CODE_LENGTH = 16
// Crockford base32: no I, L, O, U.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/** A fresh code, grouped by four for reading. */
export function generateRecoveryCode(): string {
    const bytes = randomBytes(CODE_LENGTH)
    let raw = ''
    for (const byte of bytes) raw += ALPHABET[byte & 31] ?? '0'
    return raw.match(/.{4}/g)?.join('-') ?? raw
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
    const codes = new Set<string>()
    while (codes.size < count) codes.add(generateRecoveryCode())
    return [...codes]
}

/**
 * What the user typed, as the stored form: case, spaces and hyphens ignored, the Crockford look-
 * alikes mapped (i, l → 1; o → 0). Null when it cannot be a code.
 */
export function normalizeRecoveryCode(input: string): string | null {
    const compact = input
        .toLowerCase()
        .replace(/[\s-]/g, '')
        .replace(/[il]/g, '1')
        .replace(/o/g, '0')
    if (compact.length !== CODE_LENGTH) return null
    for (const char of compact) if (!ALPHABET.includes(char)) return null
    return compact
}

export const hashRecoveryCode = (normalized: string): string =>
    hashOtpVerificationCode(`mfa-recovery:${normalized}`)

export const recoveryCodes = {
    /** Voids every code of the user and stores a new batch, in `tx`; answers the codes to show once. */
    async issue(userId: UserId, tx: DbExecutor): Promise<string[]> {
        const codes = generateRecoveryCodes()
        const hashes = codes.map((code) => {
            const normalized = normalizeRecoveryCode(code)
            if (normalized === null) throw new Error('generated recovery code does not normalize')
            return hashRecoveryCode(normalized)
        })
        await recoveryCodeRepository.replaceBatch(userId, hashes, nanoid(), tx)
        return codes
    },

    /** Spends the code the user typed: true only for the request that marked it used. */
    async consume(userId: UserId, input: string, executor?: DbExecutor): Promise<boolean> {
        const normalized = normalizeRecoveryCode(input)
        if (normalized === null) return false
        return recoveryCodeRepository.consume(userId, hashRecoveryCode(normalized), executor)
    },

    remaining(userId: UserId, executor?: DbExecutor): Promise<number> {
        return recoveryCodeRepository.countUnused(userId, executor)
    },

    /** Removes every code of the user (MFA turned off, reset, claim). */
    removeAll(userId: UserId, tx: DbExecutor): Promise<number> {
        return recoveryCodeRepository.deleteByUserId(userId, tx)
    },
}
