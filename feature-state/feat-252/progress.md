# feat-252: MFA review fixes 4

## Status

Implemented, ready for review. Branch `fix/mfa-review-4`.

## Scope (review of feat-251, 2026-11-23)

1. A lost single PostgreSQL connection retries the lock on a new connection; only a connect-time
   failure deletes without the lock, anything else keeps the session (503 `logout_retry`).
2. The ticket cookie is cleared only when this ticket was retired or is absent.
3. The post-activation effects run exactly once, by the request that finishes the sign-in (a
   one-shot claim after the replacement).
4. The MFA form keeps the pending request after 429 and 408.
5. A logout that keeps the session re-registers the push subscription; the browser unsubscribes
   only after a logout that went through.

## Evidence of Completion

- `make check` green: backend 3675, frontend 997, shared 147, landing 103, api-playground 115,
  documentation 26.
- `pnpm test:pg` (PG_TEST_URL set): 71 files, 678 passed, 0 skipped.
- `pnpm test:redis` (REDIS_TEST_URL set): 20 files, 198 passed.
- `pnpm --filter frontend test:e2e`: 133 passed.
- `test:e2e:live`: 41 passed; `account-profile.spec.ts:170` fails locally only (more than 100
  accounts in the local live database; CI starts empty). `playwright.live-passkey.config.ts`: 3
  passed.
- `pnpm docs:build && pnpm docs:verify`: passed.

## Manual verification

The golden paths are covered by the live suites above: sign-out (including the WebSocket close),
sign-in with TOTP and passkey, reload during the second step, recovery sign-in.
