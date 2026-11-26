import { nanoid } from 'nanoid'

import { recoveryCodeRepository } from '#app/repositories/index.js'
import type { DbExecutor } from '#app/repositories/index.js'
import { otpHashKey } from '#app/services/auth/otp-verification-hash.js'
import {
    hashRecoveryCode as hashRecoveryCodeWith,
    newRecoveryCode,
    normalizeRecoveryCode as normalizeRawRecoveryCode,
    rawRecoveryCodeOf,
    type NormalizedRecoveryCode,
    type RawRecoveryCode,
    type RecoveryCodeHash,
} from '#app/domain/secrets.js'
import type { UserId } from '#app/domain/ids.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р8): one-time recovery codes. 16 characters of the
// Crockford base32 alphabet (80 bits), shown as xxxx-xxxx-xxxx-xxxx. Stored as HMAC-SHA256 with
// AUTH_OTP_HMAC_KEY (APP_KEY when unset), like the SMS codes: the entropy makes a slow hash
// unnecessary and the check stays cheap under the per-user throttle.

export const RECOVERY_CODE_COUNT = 10

/** A fresh code, grouped by four for reading. */
export const generateRecoveryCode = (): RawRecoveryCode => newRecoveryCode()

/** What the user typed, in the stored form, or null when it cannot be a code. */
export const normalizeRecoveryCode = (input: string): NormalizedRecoveryCode | null =>
    normalizeRawRecoveryCode(rawRecoveryCodeOf(input))

/** The stored hash of a normalized code, under the OTP key of the config. */
export const hashRecoveryCode = (code: NormalizedRecoveryCode): RecoveryCodeHash =>
    hashRecoveryCodeWith(otpHashKey(), code)

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): RawRecoveryCode[] {
    const codes = new Set<RawRecoveryCode>()
    while (codes.size < count) codes.add(newRecoveryCode())
    return [...codes]
}

export const recoveryCodes = {
    /** Voids every code of the user and stores a new batch, in `tx`; answers the codes to show once. */
    async issue(userId: UserId, tx: DbExecutor): Promise<RawRecoveryCode[]> {
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
