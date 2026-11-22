# feat-246 Passkeys — progress

Plan: `docs/plan/passkeys-mfa-plan.md` (rev. 7, Р5, Р6, Р9, Р12), tasks:
`docs/plan/passkeys-mfa-tasks.md` (rev. 3, P0–P6). Branch `feat/passkeys`. Registry: #771
(in_progress). Depends on feat-245 (done, #767).

## Current State

- P0: done. `./init.sh` on the branch cut from `main` (after #771): `make check` green (backend
  3467, frontend 924, shared 139, api-playground 115, landing 103, documentation 26), build green.

## Files Modified

See `git log` of the branch.

## Next Step

P1: `@simplewebauthn/server` 14.1.0 and `@simplewebauthn/browser` 14.0.0, `config/webauthn.ts`,
migration `webauthn_credentials` + `users.webauthn_user_handle`, notification kinds and audit
actions, `claimLocked` and `signInCapability`.

## Notes for Next Session

- PG/Redis suites run against the local containers `vibe-sched-pg` (127.0.0.1:5440) and
  `vibe-sched-redis` (127.0.0.1:6390):
  `PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5440/postgres REDIS_TEST_URL=redis://127.0.0.1:6390`.

## Evidence of Completion

(pending)
