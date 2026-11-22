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
- P5: `usePasskeys` (lazy library), sign-in button and conditional UI (started by a user action
  in the identifier field), passkey in MfaChallengeForm and ReauthDialog, PasskeyList; the OAuth
  second-step URL names the methods; passkey sign-in routes have their own rate limit.
- P6: `backend/mfa.md` (uk + en) Passkeys section, configuration and auth pages, STL-MFA-006.

## Files Modified

See `git log` of the branch.

## Next Step

PR `feat/passkeys` → `main`, status `review`, merge after every CI job is green, then
"Mark feat-246 done". Next feature: feat-247 (staff MFA).

## Notes for Next Session

- PG/Redis suites run against the local containers `vibe-sched-pg` (127.0.0.1:5440) and
  `vibe-sched-redis` (127.0.0.1:6390):
  `PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5440/postgres REDIS_TEST_URL=redis://127.0.0.1:6390`.

## Evidence of Completion

2026-11-22, local, branch head after the P5/P6 fixes:

- `make check`: exit 0 — backend 3533, frontend 931, shared 142 pass / 0 fail, api-playground 115,
  landing 103, documentation 26; format, typecheck, lint, bundle graph clean.
- `pnpm test:pg` (PG_TEST_URL set): 66 files, 585 tests passed, 0 skipped.
- `pnpm test:redis` (REDIS_TEST_URL set): 20 files, 195 tests passed, 0 skipped.
- `pnpm --filter frontend test:e2e`: 127 passed (`e2e/mock/passkeys.spec.ts` 2, CDP virtual
  authenticator).
- `pnpm --filter frontend test:e2e:live`: 39 passed, including `passkeys.spec.ts` (3) and
  `mfa.spec.ts` (3); `account-profile.spec.ts` › "a name with markup…" fails locally only
  (accumulated accounts in the dev database; CI starts clean).
- `pnpm docs:build && pnpm docs:verify`: all checks passed.

Golden path checked by the live specs with a virtual authenticator: a passkey added from the
account page (codes shown once), a sign-in with the passkey alone from the autofill and from the
button, the passkey as the second step after the password, and the recovery of a lost passkey
(last recovery code → a new passkey → the lost one removed → new codes → finish → password +
new passkey). The PG/Redis suites cover the shared WebAuthn criterion over the four ceremonies,
idempotent registration, concurrent removals, the counter rule and the passkey-only recovery
path over HTTP.
