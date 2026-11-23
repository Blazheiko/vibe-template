# feat-250 MFA Review Fixes 2 — progress

Second review of feat-249 (2026-11-23, REQUEST CHANGES). Branch `fix/mfa-review-2`. Registry:
#787 (in_progress).

## Current State

- Blocker 1: the request's own session is checked under the actor's row lock at a role change and
  an MFA reset; ending one session deletes the record under the user's row lock.
- Blocker 2: `POST /auth/mfa/verify { method: 'continue' }` finishes a confirmed, browser-bound
  ticket without the form's state (open ticket: 401 mfa_attempt_expired, nothing counted; a
  rollback reopens the ticket for a new proof); the form continues when the options answer pending.
- Medium 3: the factor switches are hidden while a completion is pending.
- Medium 4: the proof of the first step of adding a factor is kept with the enrollment and recorded.
- Third review: a plain logout under the user's row lock (hook); `POST /auth/mfa/state` brings the
  second step back after a reload; the verify answer carries the recovery state.

## Files Modified

See `git log` of the branch.

## Next Step

PR, status `review`, merge after every CI job is green, "Mark feat-250 done".

## Notes for Next Session

- PG/Redis suites: `PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5440/postgres
REDIS_TEST_URL=redis://127.0.0.1:6390`.

## Evidence of Completion

2026-11-23, local, the merged branch:

- `make check`: exit 0 — backend 3631, frontend 973, shared 147, api-playground 115, landing 103,
  documentation 26.
- After the third review: `make check` green (frontend 981), `test:pg` 70 files 658 passed,
  `test:redis` 198, `test:e2e` 133, docs build and verify passed.
- `pnpm test:pg` (PG_TEST_URL set): 70 files, 647 passed, 0 skipped (new:
  privileged-session-revocation.pg.test.ts 6, the `continue` cases of mfa-sign-in-http 5, the kept
  add-factor proof 4).
- `pnpm test:redis` (REDIS_TEST_URL set): 20 files, 198 passed.
- `pnpm --filter frontend test:e2e`: 132 passed.
- `pnpm docs:build && pnpm docs:verify`: passed.
