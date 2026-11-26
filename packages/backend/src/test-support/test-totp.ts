import { nowUnixMs } from 'shared/brand'
import type { UserId } from '#app/domain/ids.js'
// feat-247 (docs/plan/passkeys-mfa-plan.md, Р10): MFA_REQUIRED_FOR_STAFF is on by default, so a
// staff account of a test has a second factor. This gives an account a confirmed TOTP factor with
// a known secret, sealed as the service seals it, and answers its current code. The modules are
// imported on the call: the suites import the database after their mocks and the skip check.

export interface TestTotp {
    /** The code of the current 30 s step, or of a step `offset` away. */
    code(offset?: bigint): string
}

export async function enrollTestTotp(userId: UserId): Promise<TestTotp> {
    const { totpFactorRepository, withTransaction } = await import('#app/repositories/index.js')
    const { mfaSecretBox, totpSecretOwner } =
        await import('#app/services/auth/mfa/mfa-secret-box.js')
    const { generateTotpSecret, hotp, totpStepAt } = await import('#app/services/auth/mfa/totp.js')

    const box = mfaSecretBox()
    if (box === null) throw new Error('no MFA key: set APP_KEY or MFA_ENCRYPTION_KEYS')
    const secret = generateTotpSecret()
    const sealed = box.seal(secret, totpSecretOwner(userId))
    await withTransaction((tx) =>
        totpFactorRepository.replace(
            {
                userId,
                enrollmentId: crypto.randomUUID().slice(0, 32),
                secretCiphertext: sealed.ciphertext,
                keyId: sealed.keyId,
                lastUsedStep: 0n,
                confirmedAt: new Date(),
            },
            tx,
        ),
    )
    return { code: (offset = 0n) => hotp(secret, totpStepAt(nowUnixMs()) + offset) }
}
