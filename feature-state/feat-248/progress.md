# feat-248 Staff Passkey Mode — progress

Plan: `docs/plan/passkeys-mfa-plan.md` (rev. 7, Р10, Р12, Д11), tasks:
`docs/plan/passkeys-mfa-tasks.md` (rev. 3, X0–X3). Branch `feat/staff-passkey-mode`. Registry: #779
(in_progress). Depends on feat-246 and feat-247 (done).

## Current State

- X0: done. `./init.sh` on the branch cut from `main` (after #779): `make check` green (backend
  3598, frontend 958, shared 143, api-playground 115, landing 103, documentation 26).
- X1: `staffMfaPolicy('passkey')`, `MFA_STAFF_FACTOR=passkey`, runtime check without WebAuthn.
- X2: the consumers follow the policy; `mfa_required_for_role` on factor removal in both modes (a
  TOTP-only staff account in passkey mode keeps TOTP until it adds a passkey: the after-state rule);
  `staffFactor` in `GET /account/mfa` and the banner; tests in both modes; branch B of Р12; a second
  live config (`playwright.live-passkey.config.ts`, own database) for the passkey mode; spent TOTP
  steps of the live run kept in a file.
- X3: Passkeys mode and the switching order in `backend/mfa.md` (uk + en), configuration,
  deployment checklist, recommendations item 7.

## Files Modified

See `git log` of the branch.

## Next Step

PR `feat/staff-passkey-mode` → `main`, status `review`, merge after every CI job is green, then
"Mark feat-248 done". The passkeys/MFA plan (feat-245…248) is then complete.

## Notes for Next Session

- PG/Redis suites: `PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5440/postgres
REDIS_TEST_URL=redis://127.0.0.1:6390`.

## Evidence of Completion

2026-11-22, local, after X2 (X3 is docs only):

- `make check`: exit 0 — backend 3631, frontend 963, shared 144, api-playground 115, landing 103,
  documentation 26.
- `pnpm test:pg` (PG_TEST_URL set): 69 files, 616 passed, 0 skipped.
- `pnpm test:redis` (REDIS_TEST_URL set): 20 files, 198 passed.
- `pnpm --filter frontend test:e2e`: 132 passed.
- `pnpm --filter frontend test:e2e:live`: 41 passed; `account-profile.spec.ts` › "a name with
  markup…" fails locally only (the persisted `vibe_e2e_live` has more than 100 accounts again; CI
  starts clean). `playwright.live-passkey.config.ts`: 1 passed (an admin with a passkey enters the
  admin area; a TOTP-only staff session gets `mfa_session_required`).
- `pnpm docs:build && pnpm docs:verify`: passed.
