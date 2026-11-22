// feat-245 / feat-247 (docs/plan/passkeys-mfa-plan.md, Р10, Р11): what MFA a staff role needs.
// One policy answers the three questions every consumer asks (role assignment, factor removal,
// can:, ws_can:, ws-role-sync, rows 9–10 of the proof matrix), so the passkey mode of feat-248
// changes behaviour in one place.

import {
    isActiveRecovery,
    latestMark,
    sessionAuthOf,
    type ProofMethod,
    type SessionAuthState,
    type VerifiedMethodRef,
} from './session-auth.js'

export const STAFF_FACTOR_MODES = ['any', 'passkey'] as const
export type StaffFactorMode = (typeof STAFF_FACTOR_MODES)[number]

export interface StaffFactors {
    totp: boolean
    passkeys: number
}

export interface StaffMfaPolicy {
    readonly mode: StaffFactorMode
    /** The account has the factor a staff role needs. */
    enrolled(factors: StaffFactors): boolean
    /**
     * When the session stops meeting the staff requirement, in ms; null when it does not meet it
     * now. The admin channel unsubscribes a socket at this moment (Р11).
     */
    sessionDeadline(
        auth: SessionAuthState | undefined | null,
        now: number,
        maxAgeHours: number,
    ): number | null
    /** The step-up proofs rows 9–10 accept. */
    readonly stepUpProofs: readonly ProofMethod[]
}

const ANY_FACTOR_MARKS: readonly VerifiedMethodRef[] = ['otp', 'webauthn']

const anyPolicy: StaffMfaPolicy = {
    mode: 'any',
    enrolled: (factors) => factors.totp || factors.passkeys > 0,
    sessionDeadline(input, now, maxAgeHours) {
        const auth = sessionAuthOf(input)
        if (auth.aal !== 2 || auth.recovery !== undefined || isActiveRecovery(auth, now)) {
            return null
        }
        const mark = latestMark(auth, ANY_FACTOR_MARKS)
        if (mark === null) return null
        const deadline = mark + maxAgeHours * 3_600_000
        return now < deadline ? deadline : null
    },
    stepUpProofs: ['totp', 'webauthn'],
}

export function staffMfaPolicy(mode: StaffFactorMode): StaffMfaPolicy {
    if (mode === 'any') return anyPolicy
    // feat-248 (X1) adds the passkey mode.
    throw new Error(`Staff MFA mode "${mode}" is not available yet`)
}

/** Whether the session meets the staff requirement now. */
export const staffSessionOk = (
    policy: StaffMfaPolicy,
    auth: SessionAuthState | undefined | null,
    now: number,
    maxAgeHours: number,
): boolean => policy.sessionDeadline(auth, now, maxAgeHours) !== null
