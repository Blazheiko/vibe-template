// feat-233: the `reason` of a 409 for DELETE /account/sessions/:id naming the session that asks.
// That one ends with a logout, not from the session list.
export const CURRENT_SESSION_REASON = 'current_session'

// docs/plan/passkeys-mfa-plan.md (Р13): the `reason` of a 503 for POST /auth/logout whose session
// record could not be deleted under the user's row lock (a role change or an MFA reset sent from
// this session holds it). The session stays signed in; the client sends the logout again.
export const LOGOUT_RETRY_REASON = 'logout_retry'
