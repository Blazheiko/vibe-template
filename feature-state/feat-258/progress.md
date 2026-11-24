# feat-258: MFA Review Fixes 8

## Status

Implemented, ready for review. Branch `fix/mfa-review-8`. Plan: section feat-258 of
`docs/plan/mfa-review-fixes-7-plan.md` (review of feat-256 and feat-257, 2026-11-24).

## Baseline

`./init.sh` on `main` (1dc0516) failed `format:check` on
`docs/vendor-core-analysis-2026-11-23.md` (reached `main` unformatted). Fixed by Prettier only, no
content change, in the registration PR #820; `main` merged into this branch afterwards.

## Scope

- 8.1 The revoked branch lets a Redis failure of `deleteIfOpen` reach the error handler (503)
  with the ticket and `mfa_bind` cookies kept; they are cleared only after a confirmed `deleted` or
  `absent`.
- 8.2 No transition path for tickets opened before feat-257 (no backward compatibility in the
  template): a deployment warning in `documentation/backend/mfa.md`, both locales.
- 8.3 `MfaChallengeForm` keeps the request after a failure with `clientCode`
  `session_unverified` or `account_changed`. Live two-tab test of the automatic `account_changed`
  reload: the other account is shown, the ticket stays open, nothing captured.
- 8.4 The TOTP setup keeps its id in `totpEnrollmentId`; a setup refused by `keptProofRefusal` is
  removed atomically for that id (`consumeSessionData`), as the passkey branch does.

## Evidence of Completion

- `make check` green: backend 3702, frontend 1017, shared 149, landing 103, api-playground 115,
  documentation 26.
- `pnpm --filter backend test:pg` (PG_TEST_URL set): 719 passed, 0 skipped.
- `pnpm --filter backend test:redis` (REDIS_TEST_URL set): 205 passed.
- `pnpm --filter frontend test:e2e`: 134 passed.
- `pnpm docs:build && pnpm docs:verify`: passed.
- `e2e-live/mfa-continuation.spec.ts` (main live config, own build): 3 passed, the new two-tab
  scenario included.
- Full local `test:e2e:live`: interrupted by the local environment. The main run gave 42 passed,
  3 failed: `account-profile.spec.ts:170` (local only, more than 100 accounts in the local
  database), and two scenarios that got 503 on registration and sign-in once the local Docker
  Redis (6379) stopped answering (PING without a reply, `docker ps` hung). The passkey and prefix
  runs then timed out starting their servers. The full live suite is the CI `e2e-live` job of the
  PR.
- CI on the branch: see the PR.

## Manual verification

Golden path in a real browser against the real backend: `mfa-continuation.spec.ts` (a lost
answer after an OAuth start, after another account's session, and another tab signing in during
the second step).
