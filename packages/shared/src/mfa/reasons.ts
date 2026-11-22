// feat-245 (docs/plan/passkeys-mfa-plan.md): the `reason` of every refusal of the MFA flows. The
// frontend maps them to texts; the backend never answers another spelling.

export const MFA_REASONS = {
    /** 403: the action needs a fresh proof; the body lists the proofs this account can give. */
    reauthRequired: 'reauth_required',
    /** 403: no proof this account can give is accepted here; sign in again. */
    signInAgainRequired: 'sign_in_again_required',
    /** 403: a staff role without the factor it needs. */
    mfaRequired: 'mfa_required',
    /** 403: a staff role whose session does not meet the requirement (level, age, recovery). */
    mfaSessionRequired: 'mfa_session_required',
    /** 401: the code or the assertion is wrong, or its step was used already. */
    invalidCode: 'invalid_code',
    /** 401: the second-step ticket is gone, foreign or out of attempts. */
    mfaTicketInvalid: 'mfa_ticket_invalid',
    /** 401: another request of this ticket finished the sign-in. */
    mfaTicketUsed: 'mfa_ticket_used',
    /** 401: the attempt took longer than its reservation; the same code may be sent again. */
    mfaAttemptExpired: 'mfa_attempt_expired',
    /** 503: the sign-in was confirmed but not finished yet; repeat the same request. */
    mfaCompletionPending: 'mfa_completion_pending',
    /** 403: a recovery session may not use this route. */
    recoverySession: 'recovery_session',
    /** 401: the recovery session has expired. */
    recoveryExpired: 'recovery_expired',
    /** 409: the account needs a verified email (or a phone with phone auth on) first. */
    recoveryContactRequired: 'recovery_contact_required',
    /** 409: a staff role keeps its last factor. */
    mfaRequiredForRole: 'mfa_required_for_role',
    /** 409: a staff role is given only to an account with a factor. */
    mfaNotEnrolled: 'mfa_not_enrolled',
    /** 409: the change would leave the account without any way to sign in. */
    lastSignInMethod: 'last_sign_in_method',
    /** 400: no setup (TOTP or passkey) of this id in this session (expired or replaced). */
    enrollmentNotFound: 'enrollment_not_found',
    /** 409 (feat-246): this passkey registration was finished with another key. */
    enrollmentUsed: 'enrollment_used',
    /** 409 (feat-246): the authenticator holds a key registered already. */
    passkeyExists: 'passkey_exists',
    /** 409 (feat-246): the account has the most passkeys it may have. */
    passkeyLimit: 'passkey_limit',
} as const

export type MfaReason = (typeof MFA_REASONS)[keyof typeof MFA_REASONS]
