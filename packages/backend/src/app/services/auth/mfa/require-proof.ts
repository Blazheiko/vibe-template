import { Result } from 'better-result'
import {
    MFA_REASONS,
    proofDecision,
    type ProofAction,
    type ProofMethod,
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

export function requireProof(gate: ProofGate): AppResult<void> {
    const decision = proofDecision({
        action: gate.action,
        account: proofAccountOf(gate.account),
        auth: gate.auth,
        now: gate.now ?? Date.now(),
        windows: {
            reauthSeconds: mfaConfig.reauthWindowSeconds,
            oauthRecentSeconds: mfaConfig.oauthRecentSeconds,
        },
        ...(gate.staffStepUpProofs !== undefined
            ? { staffStepUpProofs: gate.staffStepUpProofs }
            : {}),
    })
    switch (decision.kind) {
        case 'ok':
            return Result.ok(undefined)
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

/**
 * The audit proof of an action this session was allowed to do (Р14): the freshest mark among the
 * ones the matrix accepts, `recovery_code` in a recovery session.
 */
export function auditProofOf(
    auth: SessionAuthState | undefined,
): 'password' | 'totp' | 'passkey' | 'recovery_code' | 'recent_sign_in' {
    if (auth?.recovery !== undefined) return 'recovery_code'
    const verified = auth?.verified ?? {}
    const candidates: [string | undefined, 'password' | 'totp' | 'passkey' | 'recent_sign_in'][] = [
        [verified.otp, 'totp'],
        [verified.webauthn, 'passkey'],
        [verified.pwd, 'password'],
        [verified.oauth, 'recent_sign_in'],
    ]
    let best: { at: number; proof: (typeof candidates)[number][1] } | null = null
    for (const [iso, proof] of candidates) {
        const at = iso === undefined ? NaN : Date.parse(iso)
        if (Number.isFinite(at) && (best === null || at > best.at)) best = { at, proof }
    }
    return best?.proof ?? 'password'
}
