import { reactive } from 'vue'
import type { ApiResponse } from '@/utils/api-error'
import { getErrorReason } from '@/utils/response-normalizer'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р3, Р15): a sensitive action answers 403
// `reauth_required` with the proofs this account can give. withReauth opens the one ReauthDialog
// (mounted in App.vue) with exactly those proofs and, once the step-up succeeded, sends the same
// request again, once. `sign_in_again_required` and `mfa_session_required` have no dialog: the
// caller sends the user to sign in again (`signInAgain`).

export type ReauthProof = 'password' | 'totp' | 'webauthn'

interface ReauthState {
    open: boolean
    proofs: ReauthProof[]
    resolve: ((done: boolean) => void) | null
}

export const reauthState = reactive<ReauthState>({ open: false, proofs: [], resolve: null })

/** Opens the dialog with these proofs; resolves true after a successful step-up. */
export function requestReauth(proofs: ReauthProof[]): Promise<boolean> {
    reauthState.resolve?.(false)
    return new Promise((resolve) => {
        reauthState.proofs = proofs
        reauthState.open = true
        reauthState.resolve = (done: boolean) => {
            reauthState.open = false
            reauthState.resolve = null
            resolve(done)
        }
    })
}

export const SIGN_IN_AGAIN_REASONS: ReadonlySet<string> = new Set([
    'sign_in_again_required',
    'mfa_session_required',
])

const proofsOf = (data: unknown): ReauthProof[] => {
    if (data === null || typeof data !== 'object') return []
    const details = (data as { details?: unknown }).details
    if (details === null || typeof details !== 'object') return []
    const proofs = (details as { proofs?: unknown }).proofs
    return Array.isArray(proofs)
        ? proofs.filter(
              (proof): proof is ReauthProof =>
                  proof === 'password' || proof === 'totp' || proof === 'webauthn',
          )
        : []
}

export interface ReauthOutcome<T> {
    response: ApiResponse<T>
    /** The action needs a new sign-in (no dialog can help); the caller redirects. */
    signInAgain: boolean
}

/**
 * Runs `call`; on `reauth_required` asks for a step-up with the proofs of the answer and runs it
 * once more. The first answer stands when the dialog was cancelled or the repeat is refused again.
 */
export async function withReauth<T>(
    call: () => Promise<ApiResponse<T>>,
): Promise<ReauthOutcome<T>> {
    const first = await call()
    const reason = getErrorReason(first.data) ?? ''
    if (SIGN_IN_AGAIN_REASONS.has(reason)) return { response: first, signInAgain: true }
    if (reason !== 'reauth_required') return { response: first, signInAgain: false }
    const proofs = proofsOf(first.data)
    if (proofs.length === 0) return { response: first, signInAgain: true }
    const done = await requestReauth(proofs)
    if (!done) return { response: first, signInAgain: false }
    return { response: await call(), signInAgain: false }
}
