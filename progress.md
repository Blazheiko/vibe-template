# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-066 - Auth Response Contract (in progress)
**Branch:** `fix/auth-response-contract`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase F2

## Status

### Done

- [x] Diagnosis: (1) `login` answered `400 "Email verification required"` after the **right** password of an unverified account (strict registration) — an oracle for "this account exists and the guess is right", and it reset the per-account login budget; (2) `registerEmailFlow` returned the generic answer for a taken address **before** hashing the password, so the duration of the answer (tens of milliseconds of scrypt) told whether the address was registered
- [x] Tests first (10 failed before the change): the unverified login answers the very same `Unauthorized` error value as a wrong password; it counts as a failed attempt (budget not reset); the verification mail is sent again in the background through `loginUnverifiedResend`, once per interval per account; no mail when throttled, when Redis is down, for a wrong password; the answer does not wait for the mail; registration hashes for a taken and for a new address, hashes before the lookup, takes as long for both (40 ms stubbed hash, difference < 40 ms), and does not hash when the throttle refused
- [x] `auth-service.ts`: the unverified check moved before the reset of the login budget and answers `invalidCredentials()`; `resendVerificationAfterUnverifiedLogin` (throttle, then `sendVerificationEmailInBackground(…, 'unverified login')`, errors only logged, never awaited by the login); the password is hashed before `findByEmail`
- [x] `throttle-policies.ts`: `loginUnverifiedResend` (scope `login_unverified_resend`, 1 per `AUTH_LOGIN_UNVERIFIED_RESEND_INTERVAL_MS`, default 5 min); policy table spec updated
- [x] Frontend: nothing to change — no code handled the old 400 text (checked by grep); the generic login-failed message is shown
- [x] Docs: `backend/auth.md`, `backend/security.md`, `backend/configuration.md`, `.env.example`

### Behaviour changes to know

- A user who registered and has not clicked the mail now sees "Invalid email or password" on login even with the right password (and gets the mail again, at most every 5 minutes). Before, they saw a specific message. This is the price of not leaking that the account exists; the registration response already tells them to check the inbox.
- A registration with a taken address now costs one password hash (as a new one always did).

## Evidence of Completion

| Check                                      | Result                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| Tests first                                | 10 of the new tests failed before the change                              |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                    |
| `pnpm test`                                | backend 1377, frontend 203, api-playground 14, shared 17, docs 26; exit 0 |
| `test:pg` with Redis / without             | 132 passed / 68 passed, 64 skipped (not affected)                         |
| `test:redis`                               | 89 passed (not affected)                                                  |
| `docs:build && docs:verify`                | passed                                                                    |

## Notes for Next Session

1. Merge this PR; then a PR flipping feat-066 to `done`
2. Next: F3 (feat-067), F4 (feat-068), then F1 (feat-065)
