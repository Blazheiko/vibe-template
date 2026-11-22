# feat-245 MFA Core — progress

Plan: `docs/plan/passkeys-mfa-plan.md` (rev. 7), tasks: `docs/plan/passkeys-mfa-tasks.md` (rev. 3,
M0–M14). Branch `feat/mfa-core`. Registry: #765 (registered), #766 (in_progress).

## Current State

- M0: done. `./init.sh` on the branch cut from `main` (`3112302`): `make check` green (backend
  3414, frontend 906, shared 120, api-playground 115, landing 103), build green.
- M1: `shared/mfa` (session auth state, proof matrix rows 1–3, 5–10, staff policy `any`,
  reasons), MFA audit actions and proofs. Contracts come with their routes (the route-contract
  test needs a route per contract).
- M2: `config/mfa.ts` (MFA_ENCRYPTION_KEYS, windows), `secret-box.ts`, throttle `mfaVerifyUser`.
  The MFA config check sits before the SMS early return of `validateRuntimeConfig`.
- M3: migration `20261122094014_mfa_totp_recovery_codes`, repositories, 4 notification kinds.
- M4: `SessionData.auth`, `updateSessionAuth` (with `removeKeys`), data updates keep `auth`,
  renewal inherits it, recovery expiry at restore (the request goes on anonymous: 401 from
  `auth_guard`, not a dedicated `recovery_expired` reason).
- M6: recovery codes (80 bits, HMAC).
- M5: TOTP (RFC vectors), `totpService` (setup/confirm/verify/disable/regenerate), `requireProof`
  with 403 `reauth_required` + `details.proofs`, routes `/account/mfa/*`.
- M7: `auth.planLogin` / `prepareLogin` / `activateLogin` (pending record, one Lua transition
  with the ticket). Single-node Redis assumed, as for the session index (no hash tag).
- M8a: ticket store (Lua). M8b: `POST /auth/mfa/verify`, password sign-in opens the ticket,
  continuation, recovery sign-in (rotation, recovery session), ticket retired by a session_web
  hook. `mfa-sign-in-http.pg.test.ts` covers the Р4 acceptance list over HTTP.
- M8c: OAuth sign-in and link confirmation through the second step (`pendingOAuthLink` written in
  the verify transaction; dropped for a recovery-code sign-in); `claimLocked` removes the factors.
- M9: recovery session (`allowInRecovery` route flag, absolute expiry, no WS token,
  `/auth/recovery/finish`).
- M10: step-up (`/auth/reauth/options`, `/auth/reauth`); `currentPassword` removed from
  change-password, link-phone/start, link-email/start and unlink (no backward compatibility);
  pending contact links retired on every MFA change. The test suites moved to the new contract.
- M11: `announceMfaChange` (notification + mail) for enabled/replaced/disabled/new codes/used code.
- M12: ReauthDialog + withReauth, MfaChallengeForm, SignInSecurity (QR in the browser), recovery
  wizard. Fixed in M13: the account page now follows the recovery state reactively (it read it
  once, before main/init answered).
- M13: `e2e/mock/mfa.spec.ts` (5), `e2e-live/mfa.spec.ts` (3); audit-log and session-revocation
  live specs without the current-password field. The mock notifications preferences test raced
  (the PUT was answered with the old matrix); fixed in the test.
- M14: `backend/mfa.md` (uk + en), auth/oauth/configuration pages, STL-MFA-001..005.
- api-playground: no change needed, it lists the routes from `/doc/routes`.

## Files Modified

See `git log` of the branch.

## Next Step

PR `feat/mfa-core` → `main`, status `review`, merge after every CI job is green, then
"Mark feat-245 done". Next feature: feat-246 (passkeys).

## Notes for Next Session

- The live e2e suite runs against the dev database of `packages/backend/.env`; accounts pile up
  between runs and `account-profile.spec.ts` › "a name with markup…" then fails locally (the
  seed user leaves the first 100 rows of the admin list). Unrelated to MFA; CI starts clean.
- PG/Redis suites run against the local containers `vibe-sched-pg` (127.0.0.1:5440) and
  `vibe-sched-redis` (127.0.0.1:6390):
  `PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5440/postgres REDIS_TEST_URL=redis://127.0.0.1:6390`.

## Evidence of Completion

Commit `d3328af` + the notifications test fix, 2026-11-22, local:

- `make check`: exit 0 — backend 3467 passed, frontend 924, shared 138 pass / 0 fail,
  api-playground 115, landing 103, documentation 26 pass / 0 fail; format, typecheck, lint,
  bundle graph clean.
- `pnpm test:pg` (PG_TEST_URL set): 61 files, 557 tests passed, 0 skipped.
- `pnpm test:redis` (REDIS_TEST_URL set): 20 files, 195 tests passed, 0 skipped.
- `pnpm --filter frontend test:e2e`: 125 passed.
- `pnpm --filter frontend test:e2e:live`: mfa (3), audit-log, session-revocation: 9 passed; the
  full suite 31 passed + the unrelated local-data failure above (CI job `e2e-live` is the proof).
- `pnpm docs:build && pnpm docs:verify`: all checks passed.

Golden path checked by the live specs: TOTP set up from the account page (QR + key, the code,
10 recovery codes once), a second browser signs in with password + TOTP (a wrong code refused),
a password change right after, the recovery path: the last recovery code → recovery wizard only
→ a new app → new codes → finish → an ordinary sign-in with the new app.
