// feat-245 (docs/plan/passkeys-mfa-plan.md, Р3): which proof each sensitive action accepts. The
// one place the matrix lives: the backend asks it before every action of the table (requireProof)
// and answers 403 with the proofs this account can give; the frontend shows only those.
//
// Rows of the matrix here: 1–2 (add a factor: the first one or another), 3 (remove a factor),
// 5 (regenerate the recovery codes), 6 (change the password), 7 (start linking a phone or an
// email), 8 (unlink an OAuth identity), 9 (change the role of another user) and 10 (reset the MFA
// of another user). Row 12 (sign-in with a recovery code) and row 16 (an OAuth link made by a
// sign-in) belong to the second sign-in step, not to a step-up.

import { seconds, type Seconds, type UnixMs } from '../brand/index.js'
import {
    isActiveRecovery,
    isFresh,
    latestMark,
    PROOF_METHOD_REF,
    sessionAuthOf,
    type ProofMethod,
    type SessionAuthState,
} from './session-auth.js'

export const PROOF_ACTIONS = [
    'mfa.add_factor',
    'mfa.remove_factor',
    'mfa.regenerate_codes',
    'password.change',
    'contact.link',
    'oauth.unlink',
    'role.assign',
    'mfa.reset_other',
] as const
export type ProofAction = (typeof PROOF_ACTIONS)[number]

/** What the policy needs to know about the account (read under the request, not cached). */
export interface ProofAccount {
    hasPassword: boolean
    totp: boolean
    passkeys: number
}

export interface ProofWindows {
    /** AUTH_REAUTH_WINDOW_SECONDS: a password or a factor proven this recently counts. */
    reauthSeconds: Seconds
    /** A sign-in through OAuth this recent stands for a proof of an account without a password. */
    oauthRecentSeconds: Seconds
}

export const DEFAULT_PROOF_WINDOWS: ProofWindows = {
    reauthSeconds: seconds(300),
    oauthRecentSeconds: seconds(600),
}

/**
 * The proof that allowed an action (Р14), as the audit log records it: the step-up proof the row
 * accepted, a fresh OAuth sign-in of an account without a password (`recent_sign_in`), or the
 * recovery code of a recovery session.
 */
export type AcceptedProof = 'password' | 'totp' | 'passkey' | 'recovery_code' | 'recent_sign_in'

const ACCEPTED_PROOF_OF: Readonly<Record<ProofMethod, AcceptedProof>> = {
    password: 'password',
    totp: 'totp',
    webauthn: 'passkey',
}

export type ProofDecision =
    | { kind: 'ok'; proof: AcceptedProof }
    | { kind: 'reauth_required'; proofs: ProofMethod[] }
    | { kind: 'sign_in_again_required' }
    | { kind: 'recovery_session' }

export const mfaEnabled = (account: ProofAccount): boolean => account.totp || account.passkeys > 0

/** The factors this account can prove, optionally narrowed (rows 9–10 in the passkey mode). */
function factorProofs(account: ProofAccount, allowed?: readonly ProofMethod[]): ProofMethod[] {
    const proofs: ProofMethod[] = []
    if (account.totp) proofs.push('totp')
    if (account.passkeys > 0) proofs.push('webauthn')
    return allowed === undefined ? proofs : proofs.filter((proof) => allowed.includes(proof))
}

const ROWS_ALLOWED_IN_RECOVERY: Readonly<Partial<Record<ProofAction, 'R' | 'R+'>>> = {
    'mfa.add_factor': 'R',
    'mfa.remove_factor': 'R+',
    'mfa.regenerate_codes': 'R+',
}

/**
 * Actions a session of an account without MFA may do by a fresh password or OAuth sign-in. Rows
 * 9–10 are here too: while MFA_REQUIRED_FOR_STAFF is off a staff account may have no factor, and
 * once it is on `can:` refuses such an account before this policy is asked.
 */
const ROWS_WITHOUT_MFA: ReadonlySet<ProofAction> = new Set([
    'mfa.add_factor',
    'password.change',
    'contact.link',
    'oauth.unlink',
    'role.assign',
    'mfa.reset_other',
])

export interface ProofInput {
    action: ProofAction
    account: ProofAccount
    auth: SessionAuthState | undefined | null
    now: UnixMs
    windows?: ProofWindows
    /** Rows 9–10: the proofs the staff policy accepts (staffMfaPolicy(mode).stepUpProofs). */
    staffStepUpProofs?: readonly ProofMethod[]
}

/**
 * The decision of row `action` of the matrix for this account and session. `ok` means the action
 * may go ahead now and names the proof that allowed it (of several fresh accepted factors, the
 * latest); otherwise the 403 the backend answers.
 */
export function proofDecision(input: ProofInput): ProofDecision {
    const { action, account, now } = input
    const windows = input.windows ?? DEFAULT_PROOF_WINDOWS
    const auth = sessionAuthOf(input.auth)

    // A recovery session (Р8) is its own mode: only the rows that rebuild the factors, and the
    // removals and new codes only once a replacement factor is in place (R+).
    if (auth.recovery !== undefined) {
        const needs = ROWS_ALLOWED_IN_RECOVERY[action]
        if (needs === undefined || !isActiveRecovery(auth, now)) return { kind: 'recovery_session' }
        if (needs === 'R+' && auth.recovery.replacementFactor === undefined) {
            return { kind: 'recovery_session' }
        }
        return { kind: 'ok', proof: 'recovery_code' }
    }

    const fresh = (proof: ProofMethod): boolean =>
        isFresh(auth, PROOF_METHOD_REF[proof], now, windows.reauthSeconds)

    if (!mfaEnabled(account)) {
        if (!ROWS_WITHOUT_MFA.has(action)) return { kind: 'sign_in_again_required' }
        if (account.hasPassword) {
            return fresh('password')
                ? { kind: 'ok', proof: 'password' }
                : { kind: 'reauth_required', proofs: ['password'] }
        }
        // No password and no factor: only a recent OAuth sign-in proves the owner.
        return isFresh(auth, 'oauth', now, windows.oauthRecentSeconds)
            ? { kind: 'ok', proof: 'recent_sign_in' }
            : { kind: 'sign_in_again_required' }
    }

    // MFA on: the password alone proves nothing (a stolen session plus a guessed password would
    // otherwise get around the second factor).
    const staffRow = action === 'role.assign' || action === 'mfa.reset_other'
    const proofs = factorProofs(account, staffRow ? input.staffStepUpProofs : undefined)
    // The proof that allowed it is the latest fresh one of the accepted factors: a fresher mark
    // of a factor this row does not accept (TOTP in the staff passkey mode) is not it.
    let accepted: ProofMethod | null = null
    let acceptedAt = -Infinity
    for (const proof of proofs) {
        if (!fresh(proof)) continue
        const at = latestMark(auth, [PROOF_METHOD_REF[proof]]) ?? -Infinity
        if (accepted === null || at > acceptedAt) {
            accepted = proof
            acceptedAt = at
        }
    }
    if (accepted !== null) return { kind: 'ok', proof: ACCEPTED_PROOF_OF[accepted] }
    return proofs.length === 0
        ? { kind: 'sign_in_again_required' }
        : { kind: 'reauth_required', proofs }
}

export interface ProofAdmissibilityInput {
    action: ProofAction
    account: ProofAccount
    /** The proof `proofDecision` accepted earlier (kept by the first step of a two-step action). */
    proof: AcceptedProof
    auth: SessionAuthState | undefined | null
    now: UnixMs
    staffStepUpProofs?: readonly ProofMethod[]
}

/**
 * feat-256 (docs/plan/mfa-review-fixes-7-plan.md, item 3): whether a proof accepted earlier still
 * allows row `action` for the account as it is now. The first step of a two-step action (a TOTP
 * setup, the options of a passkey) keeps what the matrix accepted then; before the second step
 * writes, the factors may have changed in another session, so the kind of proof is checked again
 * against the same matrix. Its freshness is not: the first step checked it, and the enrollment's
 * own lifetime bounds it. A recovery code needs a recovery session still active at `now`.
 */
export function isProofAdmissible(input: ProofAdmissibilityInput): boolean {
    const { action, account, proof, now } = input
    const auth = sessionAuthOf(input.auth)

    if (auth.recovery !== undefined) {
        const needs = ROWS_ALLOWED_IN_RECOVERY[action]
        if (proof !== 'recovery_code' || needs === undefined) return false
        if (!isActiveRecovery(auth, now)) return false
        return needs === 'R' || auth.recovery.replacementFactor !== undefined
    }
    if (proof === 'recovery_code') return false

    if (!mfaEnabled(account)) {
        if (!ROWS_WITHOUT_MFA.has(action)) return false
        return account.hasPassword ? proof === 'password' : proof === 'recent_sign_in'
    }

    const staffRow = action === 'role.assign' || action === 'mfa.reset_other'
    const proofs = factorProofs(account, staffRow ? input.staffStepUpProofs : undefined)
    return proofs.some((method) => ACCEPTED_PROOF_OF[method] === proof)
}

/** The proofs a step-up (POST /auth/reauth) of this account may use at all. */
export function stepUpProofsOf(account: ProofAccount): ProofMethod[] {
    if (mfaEnabled(account)) return factorProofs(account)
    return account.hasPassword ? ['password'] : []
}
