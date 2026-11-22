# feat-245 MFA Core — progress

Plan: `docs/plan/passkeys-mfa-plan.md` (rev. 7), tasks: `docs/plan/passkeys-mfa-tasks.md` (rev. 3,
M0–M14). Branch `feat/mfa-core`. Registry: #765 (registered), #766 (in_progress).

## Current State

- M0: done. `./init.sh` on the branch cut from `main` (`3112302`): `make check` green (backend
  3414, frontend 906, shared 120, api-playground 115, landing 103), build green.

## Files Modified

See `git log` of the branch.

## Next Step

M1 (shared types, proof policy, contracts).

## Notes for Next Session

- PG/Redis suites run against the local containers `vibe-sched-pg` (127.0.0.1:5440) and
  `vibe-sched-redis` (127.0.0.1:6390):
  `PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5440/postgres REDIS_TEST_URL=redis://127.0.0.1:6390`.

## Evidence of Completion

(pending)
