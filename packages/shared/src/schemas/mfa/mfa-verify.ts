import { type } from '@arktype/type'

import { AuthenticationResponseSchema } from '../passkeys/webauthn-response.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р4): the second sign-in step. A repeat of the same
// request finishes a sign-in an earlier one confirmed. feat-246: a passkey answers the options of
// POST /auth/mfa/webauthn/options instead of a code. `continue` carries no proof: it only finishes a
// sign-in this browser's ticket already confirmed (its answer was lost or the page reloaded).
// feat-256 (docs/plan/mfa-review-fixes-7-plan.md, item 6): `attemptId` names the logical attempt of
// a proof; the browser sends the same one only with a repeat of the same request, so a wrong proof
// is counted once whether or not its first answer arrived.
const ATTEMPT_ID = /^[\w-]{16,64}$/
export const MfaVerifyInputSchema = type({
    method: "'totp' | 'recovery_code'",
    code: 'string >= 6 & string <= 64',
    'attemptId?': ATTEMPT_ID,
    '+': 'reject',
})
    .or({
        method: "'webauthn'",
        response: AuthenticationResponseSchema,
        'attemptId?': ATTEMPT_ID,
        '+': 'reject',
    })
    .or({
        method: "'continue'",
        '+': 'reject',
    })

export type MfaVerifyInput = typeof MfaVerifyInputSchema.infer
