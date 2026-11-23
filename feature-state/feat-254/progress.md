# feat-254: MFA review fixes 6

## Status

Implemented, ready for review. Branch `fix/mfa-review-6`.

## Scope (reviews of feat-253 and of this branch, 2026-11-23)

1. Every step that can fail and must be repeated runs before the replaced session is deleted; the
   repeat keeps CSRF and the ticket binding (tested through real HTTP).
2. The recovery cleanup closes only the rotated token's sockets.
3. The push record is deleted by the server as part of a logout that went through
   (`pushEndpoint`); the client release/restore machinery and its races are removed.

## Evidence of Completion

- `make check` green: backend 3702, frontend 1001, shared 148, landing 103, api-playground 115,
  documentation 26.
- `pnpm test:pg` (PG_TEST_URL set): 72 files, 696 passed, 0 skipped.
- `pnpm test:redis` (REDIS_TEST_URL set): 20 files, 199 passed.
- `pnpm --filter frontend test:e2e`: 133 passed.
- `test:e2e:live`: 41 passed; `account-profile.spec.ts:170` fails locally only (more than 100
  accounts in the local live database; CI starts empty). `playwright.live-passkey.config.ts`: 3
  passed.
- `pnpm docs:build && pnpm docs:verify`: passed.

## Manual verification

The golden paths are covered by the live suites above: sign-out (including the WebSocket close
and the push account switch), sign-in with TOTP and passkey, recovery sign-in.
