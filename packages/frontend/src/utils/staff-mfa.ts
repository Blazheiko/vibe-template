// feat-247 (docs/plan/passkeys-mfa-plan.md, Р10): the backend refuses a staff role the admin area
// with 403 `mfa_required` (the account has no second factor) or `mfa_session_required` (this
// session did not prove one recently). Either way the way out is on the account page: set up a
// factor, or sign in again with it.

export const STAFF_MFA_REASONS = ['mfa_required', 'mfa_session_required'] as const
export type StaffMfaReason = (typeof STAFF_MFA_REASONS)[number]

export const isStaffMfaReason = (value: unknown): value is StaffMfaReason =>
    typeof value === 'string' && (STAFF_MFA_REASONS as readonly string[]).includes(value)

/** The security section of the account page, with the reason it explains. */
export const staffMfaTarget = (reason: StaffMfaReason): string =>
    `/account?section=security&reason=${reason}`

/** A request of the admin area (`can:` guards exactly these). */
export const isStaffApiRoute = (route: string): boolean =>
    /\/(admin|prompts)(\/|\?|$)/.test(route.split('?')[0] ?? '')
