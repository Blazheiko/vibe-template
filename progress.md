# feat-101 — Session Layer Cleanup

Plan: `docs/plan/session-layer-cleanup-plan.md`. Branch: `fix/feat-101-session-cleanup` (from `main` at `197ce02`). PR #338.

## Current State

All four plan steps are done.

- [x] Commit 1 (`d4a74e7`, docs fixed in `88f2928`) — logout-all: `destroyAllSessions(userToken)` returns `{ deleted, complete }`, no cursor, no `keepSessionId`; `RequestSession.logoutAll` issues the anonymous session in `finally`; `authService.logoutAll` answers 200 after a successful rotation whatever the cleanup does; `Session.destroyAllSessions` removed; every mock migrated; docs + ADR 0002 note.
- [x] Commit 2 (`fcf939f`) — re-sent stored anonymous cookie gets `anonAge` (`storedSessionTtl` in `session-ttl.ts`).
- [x] Commit 3 (`6ff6c13`) — `session_api` removed.
- [x] Commit 4 (`a0cd77c`) — `destroySession()` without an argument, `safeEqual` for the OAuth state (CSRF keeps its format check), `index.ts` comment on `unhandledRejection`.

## Files Modified

- `vendor/utils/session/`: `redis-session-storage.ts`, `request-session.ts`, `session-handler.ts`, `session-ttl.ts` (new), `logout-all.redis.test.ts` (was `logout-all-retry.redis.test.ts`), specs.
- `vendor/types/types.d.ts`, `vendor/utils/context/http-context.ts`, `vendor/utils/helpers/safe-equal.ts` (new) + spec; `vendor/utils/middlewares/http/session-api.ts` (deleted).
- `app/services/auth/`: `auth-service.ts`, `account-claim-service.ts`, `oauth-service.ts`, specs and pg tests; `app/middlewares/kernel.ts`, `app/middlewares/csrf-guard.ts`, `app/services/core/main-service.ts`, `index.ts`.
- Docs: `documentation/backend/{auth,controllers,request-lifecycle,middlewares,oauth}.md`, `docs/adr/0002-session-revocation-via-user-token.md`.

## Evidence of Completion

- `pnpm typecheck` clean, `pnpm lint` clean, `pnpm format:check` clean.
- `pnpm test`: backend 2152 (+11 vs. main), frontend 400, api-playground 62, shared 25, documentation 26.
- `pnpm --filter backend test:redis`: 9 files, 91 tests passed, nothing skipped (local Redis db 15 and CI `test-redis`).
- `pnpm --filter backend test:pg`: 19 files, 182 tests passed, nothing skipped (CI `test-pg`, run 41673156386; no disposable database locally).
- `pnpm docs:build && pnpm docs:verify`: all checks passed.
- CI on PR #338: quality, e2e, e2e-live, build, test-pg, test-redis green.
- Mutation checks: the new anonymous-lifetime test fails on the previous `request-session.ts`; the logout-all tests in `session-before-send.spec.ts` (anonymous after a throw) fail without the `finally`.
- Manual, built backend on port 3311 against local PostgreSQL and Redis (own Redis prefix):
    - two browsers signed in → `POST /api/auth/logout-all` in one → `200 {deletedCount: 2, csrfToken}`; both browsers and the caller's old cookie get `401` on `/api/main/init`; 0 records left.
    - `REDIS_LOGOUT_ALL_DEADLINE_MS=1` (rotation done, cleanup stopped) → `200 {deletedCount: 0, csrfToken}`, 2 records left in Redis, all three cookies `401`; log has `Stopped deleting all sessions` and `Logout-all: not every session record was deleted` warnings.
    - `CLIENT PAUSE 2000 ALL` before the request (Redis unavailable while the session is restored) → `503 service_unavailable`; after the pause the same cookie answers `200`, i.e. `session_token` was not rotated.
    - anonymous session with OAuth state (`/api/auth/oauth/github/redirect`, dummy client id), refresh marker removed → the re-sent cookie has `Max-Age=7200` (`SESSION_ANON_TTL`), not 24 h.

## Notes for Next Session

- Remaining: merge PR #338, then the "Mark feat-101 done" PR (evidence into `feature_list.json`, delete this file).
