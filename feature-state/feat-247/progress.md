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
- S2: `users.mfa.reset`, `POST /admin/users/:id/mfa/reset`, CLI `user:mfa-reset`, admin dialog;
  the reset keeps the last way in (409 without exception), rotates the token, ends the sessions.
- S3: the staff policy in can:, ws_can:, ws-role-sync and the admin channel (deadline, drop before
  publish, timer); step-up updates connections on every instance (`session_auth_changed`).
- S4: the client leaves an admin page on `access_changed { reason: 'mfa_session_required' }`;
  e2e-live/staff-mfa.spec.ts.
- S5: `MFA_REQUIRED_FOR_STAFF` defaults to true; 409 `mfa_not_enrolled` for a staff role without a
  factor (HTTP and CLI); seed TOTP for the demo admin; redirect to the security section; fixtures
  and live specs sign staff in with TOTP. The local `vibe_e2e_live` database was dropped once
  (its seeded admin had no factor; CI starts clean).
- S6: `backend/mfa.md` Staff section (uk + en), roles-capabilities, configuration, scripts.

## Files Modified

See `git log` of the branch.

## Next Step

PR `feat/staff-mfa` → `main`, status `review`, merge after every CI job is green, then
"Mark feat-247 done". Next: feat-248 (staff passkey mode).

## Notes for Next Session

- PG/Redis suites: `PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5440/postgres
REDIS_TEST_URL=redis://127.0.0.1:6390`.

## Evidence of Completion

2026-11-22, local, after S5 (S6 is docs only):

- `make check`: exit 0 — backend 3598, frontend 958, shared 143, api-playground 115, landing 103,
  documentation 26.
- `pnpm test:pg` (PG_TEST_URL set): 67 files, 602 passed, 0 skipped.
- `pnpm test:redis` (REDIS_TEST_URL set): 20 files, 198 passed (two instances: a step-up on one
  updates a connection on the other).
- `pnpm --filter frontend test:e2e`: 131 passed.
- `pnpm --filter frontend test:e2e:live`: 42 passed (staff-mfa: an MFA reset closes the open admin
  tab; roles: staff signed in with TOTP, a promotion without a factor gets 409).
- `pnpm --filter frontend test:e2e:security` (a throwaway database): 6 passed, 1 failed ("session
  lost in another tab") — it fails the same way without this feature's changes; not run in CI.
- `pnpm docs:build && pnpm docs:verify`: passed.

Golden path: a support operator with TOTP keeps the admin area open; the admin resets the factors
(fresh proof, reason); the tab leaves for the sign-in; the password signs in without a second
step. The last-admin path: the real `user:mfa-reset` process (mfa-reset.pg.test.ts).
