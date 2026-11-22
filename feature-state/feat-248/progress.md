# feat-248 Staff Passkey Mode — progress

Plan: `docs/plan/passkeys-mfa-plan.md` (rev. 7, Р10, Р12, Д11), tasks:
`docs/plan/passkeys-mfa-tasks.md` (rev. 3, X0–X3). Branch `feat/staff-passkey-mode`. Registry: #779
(in_progress). Depends on feat-246 and feat-247 (done).

## Current State

- X0: done. `./init.sh` on the branch cut from `main` (after #779): `make check` green (backend
  3598, frontend 958, shared 143, api-playground 115, landing 103, documentation 26).

## Files Modified

See `git log` of the branch.

## Next Step

X1: `staffMfaPolicy('passkey')`, `MFA_STAFF_FACTOR=passkey`, runtime check; X2: consumers,
`mfa_required_for_role` on factor removal in both modes, banner, matrices, branch B of Р12.

## Notes for Next Session

- PG/Redis suites: `PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5440/postgres
REDIS_TEST_URL=redis://127.0.0.1:6390`.

## Evidence of Completion

(pending)
