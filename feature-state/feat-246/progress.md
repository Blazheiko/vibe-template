# feat-246 Passkeys — progress

Plan: `docs/plan/passkeys-mfa-plan.md` (rev. 7, Р5, Р6, Р9, Р12), tasks:
`docs/plan/passkeys-mfa-tasks.md` (rev. 3, P0–P6). Branch `feat/passkeys`. Registry: #771
(in_progress). Depends on feat-245 (done, #767).

## Current State

- P0: done. `./init.sh` on the branch cut from `main` (after #771): `make check` green (backend
  3467, frontend 924, shared 139, api-playground 115, landing 103, documentation 26), build green.
- P1: `@simplewebauthn/server` 14.1.0 / `browser` 14.0.0; `config/webauthn.ts`; migration
  `20261122134844_webauthn_credentials`; `webauthnCredentialRepository`; kinds and audit actions;
  claim removes passkeys and the handle; the user transformer drops the handle.
- P2: `webauthn-ceremony.ts` (one verification for all four ceremonies, architecture test),
  `passkeyService` and `/account/passkeys`; `test-support/soft-authenticator.ts`.
- P3: `/auth/passkey/options` + `/auth/passkey/verify` (level-2 sign-in, Redis GETDEL challenge).
- P4: passkey second step (`/auth/mfa/webauthn/options`, `mfa/verify` method `webauthn`) and
  step-up (`/auth/reauth/webauthn/options`, `reauth` proof `webauthn`); the passkey-only
  recovery path (branch A).

## Files Modified

See `git log` of the branch.

## Next Step

P5: frontend (sign in with a passkey, conditional UI, passkey in MfaChallengeForm and
ReauthDialog, the list in SignInSecurity), mock e2e and e2e-live with a CDP virtual
authenticator; then P6 docs and closing.

## Notes for Next Session

- PG/Redis suites run against the local containers `vibe-sched-pg` (127.0.0.1:5440) and
  `vibe-sched-redis` (127.0.0.1:6390):
  `PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5440/postgres REDIS_TEST_URL=redis://127.0.0.1:6390`.

## Evidence of Completion

(pending)
