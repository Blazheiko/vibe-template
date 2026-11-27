// feat-245 / feat-247 (docs/plan/passkeys-mfa-plan.md, Р10, Р11): what MFA a staff role needs.
// One policy answers the three questions every consumer asks (role assignment, factor removal,
// can:, ws_can:, ws-role-sync, rows 9–10 of the proof matrix), so the passkey mode of feat-248
// changes behaviour in one place.

import { addMs, ms, type UnixMs } from '../brand/index.js'
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
        now: UnixMs,
        maxAgeHours: number,
    ): UnixMs | null
    /** The step-up proofs rows 9–10 accept. */
    readonly stepUpProofs: readonly ProofMethod[]
}

// A mark more than a minute in the future (a skewed clock, or a forged mark) does not count, so
// it cannot push the deadline past the configured age (the bound of `isFresh`).
const ANY_FACTOR_MARKS: readonly VerifiedMethodRef[] = ['otp', 'webauthn']

const anyPolicy: StaffMfaPolicy = {
    mode: 'any',
    enrolled: (factors) => factors.totp || factors.passkeys > 0,
    sessionDeadline(input, now, maxAgeHours) {
        const auth = sessionAuthOf(input)
        if (auth.aal !== 2 || auth.recovery !== undefined || isActiveRecovery(auth, now)) {
            return null
        }
        const mark = latestMark(auth, ANY_FACTOR_MARKS, now)
        if (mark === null) return null
        const deadline = addMs(mark, ms(maxAgeHours * 3_600_000))
        return now < deadline ? deadline : null
    },
    stepUpProofs: ['totp', 'webauthn'],
}

const PASSKEY_MARKS: readonly VerifiedMethodRef[] = ['webauthn']

// feat-248 (Р10, Д11): phishing-resistant staff access. The session must have been signed in
// with a passkey (`amr`), and only a passkey refreshes it: a TOTP sign-in with a passkey step-up
// does not qualify, the staff member signs in again with the passkey.
// Level 2 is checked as well (Р3): a passkey sign-in is level 2 by itself.
const passkeyPolicy: StaffMfaPolicy = {
    mode: 'passkey',
    enrolled: (factors) => factors.passkeys > 0,
    sessionDeadline(input, now, maxAgeHours) {
        const auth = sessionAuthOf(input)
        if (
            auth.aal !== 2 ||
            !auth.amr.includes('webauthn') ||
            auth.recovery !== undefined ||
            isActiveRecovery(auth, now)
        ) {
            return null
        }
        const mark = latestMark(auth, PASSKEY_MARKS, now)
        if (mark === null) return null
        const deadline = addMs(mark, ms(maxAgeHours * 3_600_000))
        return now < deadline ? deadline : null
    },
    stepUpProofs: ['webauthn'],
}

export function staffMfaPolicy(mode: StaffFactorMode): StaffMfaPolicy {
    return mode === 'passkey' ? passkeyPolicy : anyPolicy
}

/** Whether the session meets the staff requirement now. */
export const staffSessionOk = (
    policy: StaffMfaPolicy,
    auth: SessionAuthState | undefined | null,
    now: UnixMs,
    maxAgeHours: number,
): boolean => policy.sessionDeadline(auth, now, maxAgeHours) !== null
