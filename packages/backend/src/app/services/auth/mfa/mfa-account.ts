import type { ProofAccount } from 'shared/mfa'

import { authConfig } from '#config/auth.js'
import { recoveryCodeRepository, totpFactorRepository } from '#app/repositories/index.js'
import type { DbExecutor, TotpFactorRow } from '#app/repositories/index.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р1, Р12): what the MFA flows need to know about an
// account, read from the database (inside the caller's transaction when it holds the row lock).

export interface MfaUserFields {
    id: bigint
    password: string | null
    email: string | null
    emailVerifiedAt: Date | null
    phone: string | null
}

export interface MfaAccount {
    userId: bigint
    hasPassword: boolean
    totp: TotpFactorRow | undefined
    /** feat-246 counts the passkeys; none before it. */
    passkeys: number
    recoveryCodesRemaining: number
    /**
     * A verified channel through which the owner can set a password again (Р12): a verified email,
     * or a phone while phone auth (and so the phone reset) is on.
     */
    hasRecoveryContact: boolean
}

export const hasPasswordOf = (user: Pick<MfaUserFields, 'password'>): boolean =>
    user.password !== null && user.password !== ''

export const hasRecoveryContactOf = (
    user: Pick<MfaUserFields, 'email' | 'emailVerifiedAt' | 'phone'>,
): boolean =>
    (user.email !== null && user.emailVerifiedAt !== null) ||
    (authConfig.phoneAuthEnabled && user.phone !== null && user.phone !== '')

export async function loadMfaAccount(
    user: MfaUserFields,
    executor?: DbExecutor,
): Promise<MfaAccount> {
    const [totp, recoveryCodesRemaining] = await Promise.all([
        totpFactorRepository.findByUserId(user.id, executor),
        recoveryCodeRepository.countUnused(user.id, executor),
    ])
    return {
        userId: user.id,
        hasPassword: hasPasswordOf(user),
        totp,
        passkeys: 0,
        recoveryCodesRemaining,
        hasRecoveryContact: hasRecoveryContactOf(user),
    }
}

export const proofAccountOf = (account: MfaAccount): ProofAccount => ({
    hasPassword: account.hasPassword,
    totp: account.totp !== undefined,
    passkeys: account.passkeys,
})

export const mfaEnabledOf = (account: MfaAccount): boolean =>
    account.totp !== undefined || account.passkeys > 0
