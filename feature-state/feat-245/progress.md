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

## Files Modified

See `git log` of the branch.

## Next Step

M7 (prepareLogin / activateLogin), then M8 (ticket).

## Notes for Next Session

- PG/Redis suites run against the local containers `vibe-sched-pg` (127.0.0.1:5440) and
  `vibe-sched-redis` (127.0.0.1:6390):
  `PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5440/postgres REDIS_TEST_URL=redis://127.0.0.1:6390`.

## Evidence of Completion

(pending)
