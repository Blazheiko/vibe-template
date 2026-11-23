# feat-253: MFA review fixes 5

## Status

Implemented, ready for review. Branch `fix/mfa-review-5`.

## Scope (review of feat-252, 2026-11-23)

1. Only 08001/08004/57P03 delete without the lock; the rest of SQLSTATE class 08 is
   `connection_lost`.
2. A failed effects claim or recovery cleanup answers `mfa_completion_pending` with no new cookie;
   the recovery cleanup is idempotent and awaited on every finishing request.
3. A push record restored after a kept logout keeps its previous `is_active`.
4. A push DELETE that outlives its bound is reconciled when it lands.

## Evidence of Completion

- `make check` green: backend 3691, frontend 1010, shared 147, landing 103, api-playground 115,
  documentation 26.
- `pnpm test:pg` (PG_TEST_URL set): 71 files, 686 passed, 0 skipped.
- `pnpm test:redis` (REDIS_TEST_URL set): 20 files, 198 passed.
- `pnpm --filter frontend test:e2e`: 133 passed.
- `test:e2e:live`: 41 passed; `account-profile.spec.ts:170` fails locally only (more than 100
  accounts in the local live database; CI starts empty). `playwright.live-passkey.config.ts`: 3
  passed.
- `pnpm docs:build && pnpm docs:verify`: passed.

## Manual verification

The golden paths are covered by the live suites above: sign-out (including the WebSocket close),
sign-in with TOTP and passkey, reload during the second step, recovery sign-in.
