# Session and Token Lifecycle Requirements: vibe-template

Last updated: 2026-05-30

## 1. Session Lifecycle

| ID              | Status              | Requirement                                                                                                            |
| --------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| STL-SESSION-001 | Implemented default | Browser sessions are Redis-backed and represented by an HTTP-only cookie.                                              |
| STL-SESSION-002 | Implemented default | Session age defaults to 24 hours.                                                                                      |
| STL-SESSION-003 | Target              | Session TTL should be configurable per deployment and documented in the privacy/session policy.                        |
| STL-SESSION-004 | Extension point     | Production deployments should define a maximum active-session count per user if account sharing or abuse is a concern. |

## 2. CSRF Lifecycle

| ID           | Status              | Requirement                                                                             |
| ------------ | ------------------- | --------------------------------------------------------------------------------------- |
| STL-CSRF-001 | Implemented default | Authenticated app initialization returns the current CSRF token to the frontend.        |
| STL-CSRF-002 | Implemented default | Unsafe cookie-backed HTTP requests send `X-CSRF-Token`.                                 |
| STL-CSRF-003 | Implemented default | Login, logout, and logout-all rotate or return fresh CSRF state when sessions mutate.   |
| STL-CSRF-004 | Target              | CSRF enforcement should move from report-only to enforce mode before production launch. |

## 3. WebSocket Token Lifecycle

| ID         | Status              | Requirement                                                                                                      |
| ---------- | ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| STL-WS-001 | Implemented default | App initialization returns WebSocket URL and token for authenticated users.                                      |
| STL-WS-002 | Implemented default | The backend exposes a token refresh endpoint for authenticated users.                                            |
| STL-WS-003 | Target              | Expired or invalid WebSocket tokens should trigger reconnect with token refresh rather than silent message loss. |
| STL-WS-004 | Target              | WebSocket token TTL and refresh policy should be explicitly documented before production hardening.              |

## 4. Account Tokens

| ID              | Status              | Requirement                                                                                        |
| --------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| STL-ACCOUNT-001 | Implemented default | Email verification tokens expire after 24 hours.                                                   |
| STL-ACCOUNT-002 | Implemented default | Password reset tokens expire and are one-time use.                                                 |
| STL-ACCOUNT-003 | Implemented default | SMS challenges default to 10-minute TTL with resend cooldown and attempt limits.                   |
| STL-ACCOUNT-004 | Target              | Password changes should define whether other active sessions are preserved or revoked.             |
| STL-ACCOUNT-005 | Target              | Logout-all should revoke all active sessions for the user and clear frontend session-scoped state. |

## Second factor and step-up (feat-245)

| ID          | Status              | Requirement                                                                                                                                                             |
| ----------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| STL-MFA-001 | Implemented default | A session records its sign-in level (`aal` 1/2, never raised), its sign-in methods and the time each method was last proven; a session stored before has nothing fresh. |
| STL-MFA-002 | Implemented default | An account with a second factor gets a 5-minute, browser-bound, one-time ticket after the first factor; only the second step creates the session.                       |
| STL-MFA-003 | Implemented default | Sensitive actions require a fresh step-up proof (300 s by default) chosen by one matrix; for an account with MFA the password alone confirms nothing.                   |
| STL-MFA-004 | Implemented default | A recovery code opens a recovery session: level 1, absolute 15-minute lifetime, no WebSocket, only the factor routes; it signs out every other session.                 |
| STL-MFA-005 | Implemented default | A password reset of a verified account keeps MFA; a takeover of an unverified address removes the factors.                                                              |
