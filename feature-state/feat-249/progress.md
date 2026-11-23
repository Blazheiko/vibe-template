# feat-249 MFA Review Fixes — progress

Review of feat-245…feat-248 (2026-11-22, verdict REQUEST CHANGES). Branch `fix/mfa-review`.
Registry: #783 (in_progress).

## Current State

- Blockers 1 and 4, mediums "reset sessions" and "audit proof": done (role assignment locks the
  target before the factor check; the actor is re-checked at the write under the row locks in
  ascending id; the reset destroys the previous token's sessions; the audit records the proof that
  allowed the action).
- Blockers 2 and 3, mediums "future marks" and "wsToken": done (the reservation is checked at
  capture; a completing ticket's passkey options answer 503 pending and the client resends the same
  request; a spent passkey challenge is mfa_attempt_expired without a failure; the staff policy
  bounds future marks and needs aal 2 in passkey mode; main/init answers wsToken null in recovery).
- ESLint ignores `.claude/**` (agent worktrees there broke `make check` with an out-of-memory).

## Files Modified

See `git log` of the branch.

## Next Step

Acceptance gaps: a live TOTP step-up through ReauthDialog, a live WebAuthn step-up, a real
connection drop during COMMIT of the second step. Then PR, review status, merge, done.

## Notes for Next Session

- PG/Redis suites: `PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5440/postgres
REDIS_TEST_URL=redis://127.0.0.1:6390`.

## Evidence of Completion

(pending)
