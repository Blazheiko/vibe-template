# feat-251: MFA review fixes 3

## Status

Implemented, ready for review. Branch `fix/mfa-review-3`.

## Scope (review of feat-250, 2026-11-23)

1. A logout whose lock wait is cut retries and then answers 503 `logout_retry`; it deletes without
   the lock only when the database is unreachable.
2. A sign-in (password, MFA activation) deletes a signed-in previous session under its user's row
   lock.
3. The MFA form keeps a request pending before sending it (a lost first `continue` can be repeated).
4. A recovery sign-in opens `/account` before the first navigation, ignoring `?redirect=`.

## Evidence of Completion

- `make check` green: backend 3660, frontend 990, shared 147, landing 103, api-playground 115,
  documentation 26.
- `pnpm test:pg` (PG_TEST_URL set): 71 files, 672 passed, 0 skipped.
- `pnpm test:redis` (REDIS_TEST_URL set): 20 files, 198 passed.
- `pnpm --filter frontend test:e2e`: 133 passed.
- `test:e2e:live`: 41 passed; `account-profile.spec.ts:170` fails locally only (more than 100
  accounts in the local live database; CI starts empty). `playwright.live-passkey.config.ts`: 3
  passed.
- `pnpm docs:build && pnpm docs:verify`: passed.

## Manual verification

The golden paths are covered by the live suites above: sign-out (including the WebSocket close),
sign-in with TOTP and passkey, reload during the second step, recovery sign-in.
