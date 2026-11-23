# feat-255: MFA error handling per ADR 0004

## Status

Implemented, ready for review. Branch `refactor/mfa-error-handling`.

## Scope (audit of `services/auth/mfa`, 2026-11-23)

1. Infrastructure failures of the ticket store and the passkey ticket challenges throw (503 for
   Redis through `classifyError`, 500 for a bug) instead of `Result.err(serviceUnavailable)`.
2. The known rollback keeps its compensation and rethrows.
3. `mfa_completion_pending` only for failures a repeat can outlive; anything else is 500.
4. Silent best-effort `.catch()` calls log a `warn`; a duplicate log-and-rethrow is removed.

## Evidence of Completion

- `make check` green: backend 3702, frontend 1001, shared 148, landing 103, api-playground 115,
  documentation 26.
- `pnpm test:pg` (PG_TEST_URL set): 72 files, 703 passed, 0 skipped.
- `pnpm test:redis` (REDIS_TEST_URL set): 20 files, 199 passed.
- `pnpm --filter frontend test:e2e`: 133 passed.
- `test:e2e:live`: 41 passed; `account-profile.spec.ts:170` fails locally only (more than 100
  accounts in the local live database; CI starts empty). `playwright.live-passkey.config.ts`: 3
  passed.
- `pnpm docs:build && pnpm docs:verify`: passed.

## Manual verification

The golden paths are covered by the live suites above: sign-in with TOTP, recovery code and
passkey, reload during the second step, sign-out.
