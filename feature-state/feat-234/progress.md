# feat-234 Active Sessions review fixes — progress

Branch `fix/active-sessions-review`, registry PR #718. Follow-up of feat-233 (#715).

## Current state

Both findings of the feat-233 review fixed, with tests that fail on the old code.

1. **HIGH, `packages/frontend/src/utils/base-api.ts`**: a change sent from a session that a renewal
   (`revoke-others`, `change-password`) is replacing gets `403 token_mismatch` once the old record
   is gone; its CSRF recovery read `main/init` at once, saw the anonymous session and signed the
   user out even when the renewal then succeeded. The recovery of an ordinary request now waits for
   the renewal in flight (a renewal never waits for itself; an abort still ends the wait). Tests in
   `base-api-session-renewal.spec.ts`: renewal succeeds → no `main/init` while it is in flight, the
   change goes out once more with the new token, no `unauthorized`; renewal fails → `unauthorized`.
   The success test failed before the fix (reproduced).
2. **MEDIUM, `packages/backend/src/app/services/auth/new-sign-in-notice.ts`**: `isFamiliarDevice`
   read only the first page; it now follows the cursor until a match or the end. Tests in
   `new-sign-in-notice.spec.ts`: a match on the third page → no mail; no match to the end → mail.
   Both failed before the fix.

Docs (both locales): `backend/security.md` (every page of the list), `backend/account.md` (the
403 recovery waits for the renewal).

3. **CI baseline, `packages/backend/src/database/redis-main.redis.test.ts`**: the session fixture had
   a fixed `createdAt: '2026-10-21'`; from 2026-11-20 it is `SESSION_MAX_AGE_DAYS` (30) old and
   `getSession` refuses it, so "a stale SETEX snapshot does not overwrite the session" failed in
   `test-redis` on #719 (not caused by this change). The fixture now uses the current time.

## Evidence of Completion

- `make check`: green — backend 3237, frontend 732 tests.
- `pnpm --filter frontend test:e2e`: 102 passed; `test:e2e:live`: 25 passed.
- `pnpm docs:build && pnpm docs:verify`: all checks passed.
- `make test-redis`: 174 passed, 0 skipped (after the fixture fix). No PG/Redis production code
  changed (the familiar-device loop calls the existing `listSessions`).
- Manual golden path: covered by `e2e-live/active-sessions.spec.ts`; no click-through by a person.
