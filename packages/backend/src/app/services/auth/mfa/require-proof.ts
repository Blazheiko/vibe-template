import { Result } from 'better-result'
import {
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
import { forbidden, reauthRequired, type AppResult } from '#app/services/shared/errors.js'
import { proofAccountOf, type MfaAccount } from './mfa-account.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р3): the gate of every action of the proof matrix.
// It answers the 403 the matrix decides; the frontend opens ReauthDialog on `reauth_required`.

export interface ProofGate {
    action: ProofAction
    account: MfaAccount
    auth: SessionAuthState | undefined
    now?: number
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
        now: gate.now ?? Date.now(),
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
