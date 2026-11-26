import { nowUnixMs, type UnixMs } from 'shared/brand'
import { Result } from 'better-result'
import {
    isProofAdmissible,
    MFA_REASONS,
    proofDecision,
    type AcceptedProof,
    type ProofAction,
    type ProofDecision,
    type ProofMethod,
    type ProofWindows,
    type SessionAuthState,
} from 'shared/mfa'

import mfaConfig from '#config/mfa.js'
import {
    badRequest,
    forbidden,
    reauthRequired,
    type AppError,
    type AppResult,
} from '#app/services/shared/errors.js'
import { proofAccountOf, type MfaAccount } from './mfa-account.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р3): the gate of every action of the proof matrix.
// It answers the 403 the matrix decides; the frontend opens ReauthDialog on `reauth_required`.

export interface ProofGate {
    action: ProofAction
    account: MfaAccount
    auth: SessionAuthState | undefined
    now?: UnixMs
    /** Rows 9–10: the proofs the staff policy accepts. */
    staffStepUpProofs?: readonly ProofMethod[]
}

/** The windows of the matrix from the configuration. */
const configuredWindows = (): ProofWindows => ({
    reauthSeconds: mfaConfig.reauthWindowSeconds,
    oauthRecentSeconds: mfaConfig.oauthRecentSeconds,
})

const decide = (gate: ProofGate, windows: ProofWindows): ProofDecision =>
    proofDecision({
        action: gate.action,
        account: proofAccountOf(gate.account),
        auth: gate.auth,
        now: gate.now ?? nowUnixMs(),
        windows,
        ...(gate.staffStepUpProofs !== undefined
            ? { staffStepUpProofs: gate.staffStepUpProofs }
            : {}),
    })

/**
 * The gate: the 403 the matrix decides, or the proof that allowed the action (Р14). The caller
 * records exactly that proof in the audit log.
 */
export function requireProof(gate: ProofGate): AppResult<AcceptedProof> {
    const decision = decide(gate, configuredWindows())
    switch (decision.kind) {
        case 'ok':
            return Result.ok(decision.proof)
        case 'reauth_required':
            return Result.err(reauthRequired(decision.proofs))
        case 'sign_in_again_required':
            return Result.err(
                forbidden('Sign in again to continue', MFA_REASONS.signInAgainRequired),
            )
        case 'recovery_session':
            return Result.err(
                forbidden('Finish recovering your account first', MFA_REASONS.recoverySession),
            )
    }
}

const ACCEPTED_PROOFS: Readonly<Record<AcceptedProof, true>> = {
    password: true,
    totp: true,
    passkey: true,
    recovery_code: true,
    recent_sign_in: true,
}

/**
 * Р14: a proof read back from session data, where the first step of a two-step action (a TOTP
 * setup, the options of a passkey) kept what `requireProof` accepted, so the second step records
 * exactly that proof.
 */
export const isAcceptedProof = (value: unknown): value is AcceptedProof =>
    typeof value === 'string' && Object.hasOwn(ACCEPTED_PROOFS, value)

/**
 * feat-256 (docs/plan/mfa-review-fixes-7-plan.md, item 3): the second step of adding a factor (a
 * TOTP confirmation, a passkey registration), under the user's row lock, before it writes. The
 * proof its first step kept must still be one the matrix accepts for the factors as they are now
 * (another session may have turned MFA on since): null when it is; otherwise the refusal, the 403
 * the matrix answers now, or "start again" when the session could give a proof now (the kept one
 * stays the audited one, so the first step is asked again).
 */
export function keptProofRefusal(gate: ProofGate & { proof: AcceptedProof }): AppError | null {
    const admissible = isProofAdmissible({
        action: gate.action,
        account: proofAccountOf(gate.account),
        proof: gate.proof,
        auth: gate.auth,
        now: gate.now ?? nowUnixMs(),
        ...(gate.staffStepUpProofs !== undefined
            ? { staffStepUpProofs: gate.staffStepUpProofs }
            : {}),
    })
    if (admissible) return null
    const now = requireProof(gate)
    if (Result.isError(now)) return now.error
    return badRequest('Start again', MFA_REASONS.enrollmentNotFound)
}
