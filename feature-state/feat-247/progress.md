# feat-247 Staff MFA — progress

Plan: `docs/plan/passkeys-mfa-plan.md` (rev. 7, Р3 rows 9–10, Р10–Р13), tasks:
`docs/plan/passkeys-mfa-tasks.md` (rev. 3, S0–S6). Branch `feat/staff-mfa`. Registry: #775
(in_progress). Depends on feat-245 (done).

## Current State

- S0: done. `./init.sh` on the branch cut from `main` (after #774): `make check` green (backend
  3533, frontend 931, shared 142, api-playground 115, landing 103, documentation 26).
- S1: role change (HTTP) needs a fresh proof of the admin (row 9; the staff policy's factors once
  the admin has MFA); the CLI is not asked; RoleChangeDialog goes through withReauth. The staff
  config (`MFA_REQUIRED_FOR_STAFF` off, `MFA_STAFF_FACTOR=any`, `MFA_STAFF_FACTOR_MAX_AGE_HOURS`)
  and `services/auth/mfa/staff-policy.ts` came with it. A system actor of the audit carries its
  source, never a proof.

## Files Modified

See `git log` of the branch.

## Next Step

S2: `users.mfa.reset`, `POST /admin/users/:id/mfa/reset`, CLI `user:mfa-reset`, admin dialog.

## Notes for Next Session

- PG/Redis suites: `PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5440/postgres
REDIS_TEST_URL=redis://127.0.0.1:6390`.

## Evidence of Completion

(pending)
