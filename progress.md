# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-059 - Session Revocation
**Branch:** `fix/session-revocation`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase B (decision: `docs/adr/0002-session-revocation-via-user-token.md`, accepted)

## Status

### Done

- [x] Diagnosis: a session in Redis was valid while its key existed. `changePassword` rotated nothing (every other session of the user stayed valid for up to 24 h); `logoutAll` and the password reset rotated or deleted, but if the SCAN/DEL did not finish (Redis unavailable, deadline) the old keys stayed valid after Redis came back. `session-handler`, `ws-session-auth` and the middlewares never compared the session's `userToken` with `users.session_token`
- [x] ADR 0002 accepted (PR #191): compare `userToken` with `users.session_token` read from the database on every authenticated request, no cache; rotate the token first in every revoking operation; `destroyAllSessions` is best-effort memory cleanup
- [x] Vendor layer: `session-token-check.ts` (`registerSessionTokenChecker`, `assertSessionTokenCurrent`; the check is registered by the app like the WS hooks and throws if it is not), `SessionVerificationUnavailableError` (503 `service_unavailable`, `Retry-After: 1`, no driver text; `handleError` branch)
- [x] `sessionHandler`: a rotated token makes the request anonymous (`401` at `auth_guard`) and drops the record best-effort; an unavailable lookup throws the 503 error instead of serving the Redis record. `wsSessionHandler` and `verifyUpgradeToken`: revoked → `missing`, unavailable → `unavailable`
- [x] App layer: `userRepository.findSessionToken` and `changePasswordIfCurrent` (one conditional `UPDATE … WHERE password = <current hash>` that also writes the rotated token), `checkSessionToken`, registration in `app/start/index.ts`
- [x] `changePassword`: conditional update (`409` for the loser of two concurrent changes), rotated token, best-effort cleanup, returns the new token; the controller renews the session under it (`renewSession(auth, session, rotatedUserToken)`)
- [x] `logoutAll`: rotates `users.session_token` first, fails the request if the rotation fails, then deletes the records
- [x] Password reset (email and phone): a failed `destroyAllSessions` is logged and no longer stops the reset (it used to return before the reset token was marked used)
- [x] Tests first where the behaviour is new: `session-revocation.spec.ts` (sessionHandler), `session-revocation.pg.test.ts` (real PostgreSQL + Redis), updated unit/Redis specs; mutation check — with the token check neutralised the four Redis-failure / database-failure / deleted-user tests fail
- [x] CI: `pg-tests.yml` gets a Redis service and `REDIS_TEST_URL` for the tests that need both (they skip without it)
- [x] Docs: `backend/auth.md` (new «Відкликання сесій», userToken, logoutAll, rotation table, WS authorization), `request-lifecycle.md`, `controllers.md`; ADR 0002 clarifications and the benchmark

- [x] Review follow-ups (3 findings): (1) the token lookup had no deadline — `connectionTimeoutMillis` only bounds the wait for a pooled connection, so a database that accepted the query and never answered would hold every authenticated request; `checkSessionToken` now races the lookup against `SESSION_TOKEN_CHECK_TIMEOUT_MS` (default 2000 ms, strict integer 1…60000, validated at start) and answers `unavailable` (503); the abandoned query keeps its pooled connection until the database answers, so later checks fail fast on `connectionTimeoutMillis`. (2) the HTTP contract is now proved over a real uWebSockets.js server with the real route table and the real `session_web`, `csrf_guard`, `auth_guard` against PostgreSQL and Redis (`session-revocation-http.pg.test.ts`, 8 tests): status codes, `Set-Cookie`, CSRF (old token → 403), the controller body, two concurrent HTTP change-password calls, the reset flow with a failing Redis cleanup (token marked used, other session already refused), `logout-all` 503, database down 503 and the lookup that never answers. Mutation checks: with the token check neutralised 5 of the 8 fail (including the reset flow); with the deadline removed the never-answering test fails. (3) the plan's phase B is synced with the implemented contract (WebSocket not closed but answered with a 503 envelope; change-password answers 200 with `sessionRenewed: false` when the new session cannot be issued; `logout-all` 503 cannot be repeated with the same session)

- [x] Residual limit of the lookup deadline closed (branch `fix/session-check-query-cancel`): the deadline only made the client stop waiting — measured on PostgreSQL, after `Promise.race` the query stayed active in `pg_stat_activity` and kept its pooled connection (`total/idle: 1 0`). The lookup now runs on its own small pool (`database/session-check-db.ts`, `SESSION_TOKEN_CHECK_POOL_MAX`, default 5) with `statement_timeout` = the deadline (the server cancels the statement, SQLSTATE 57014; the pool drops the errored connection and opens a new one) and `query_timeout` = deadline + 500 ms for a server that stops answering altogether (the driver gives up and the connection is destroyed, so the slot is freed). `statement_timeout` is a property of the connection, hence a separate pool rather than the main one; it also isolates authentication from long business queries. Connection options are shared with the main pool (`database/pool-options.ts`) so the later `PGSQL_SSL` (feat-067) applies to both. Proved on a real PostgreSQL: a table lock makes the lookup hang → `unavailable` within the deadline and no waiting statement left on the server; six concurrent stuck checks on a 2-connection pool all answer and the pool recovers; the main pool keeps answering meanwhile; a stalling proxy → the slot is freed by `query_timeout`. Mutation checks: without `statement_timeout` 2 of 5 fail, without `query_timeout` 1 of 5 fails

### Behaviour changes to know

- `change-password` and `logout-all` now revoke every session of the user immediately (before: change-password revoked nothing; logout-all only deleted records).
- `logout-all` cannot be repeated with the same session after a `503`: the session is already revoked. The caller signs in again.
- If the database cannot answer the token lookup, authenticated requests get `503` (before: served from the Redis record alone). WS messages get the 503 envelope, WS upgrades `503`.
- Password reset no longer fails when the Redis cleanup fails.

### Cost (local PostgreSQL over loopback, 1000 requests)

|                                    | p50     | p95     | p99     |
| ---------------------------------- | ------- | ------- | ------- |
| `sessionHandler` without the check | 0.10 ms | 0.19 ms | 0.26 ms |
| `sessionHandler` with the check    | 0.37 ms | 0.99 ms | 3.70 ms |
| the lookup alone (PK read)         | 0.11 ms | 0.17 ms | 0.21 ms |

Input for feat-061 (optional cache): on a shared network the database round trip is added.

## Evidence of Completion

| Check                                                                                                                                                                   | Result                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Mutation check (token check neutralised)                                                                                                                                | 4 of 8 `session-revocation.pg.test.ts` tests fail: Redis cleanup failure on change-password and on logout-all, database down, deleted user |
| `pnpm typecheck` / `lint` / `format:check`                                                                                                                              | exit 0                                                                                                                                     |
| `pnpm test`                                                                                                                                                             | backend 1200, frontend 168, api-playground 14, shared 14, docs 26; exit 0                                                                  |
| `test:pg` with Redis (`REDIS_TEST_URL`)                                                                                                                                 | 45 passed in 6 files (8 new in `session-revocation.pg.test.ts`)                                                                            |
| `test:pg` with Redis unreachable (no `REDIS_TEST_URL`)                                                                                                                  | 37 passed, 8 skipped                                                                                                                       |
| `test:redis` (`REDIS_TEST_URL=redis://127.0.0.1:6379/15`)                                                                                                               | 61 passed (stopped-logout-all test rewritten for the rotation-first model)                                                                 |
| `docs:build && docs:verify`                                                                                                                                             | passed                                                                                                                                     |
| `test:e2e:security` (real prod build and server on port 3200, `PORT=3200` for the build too, fixture restored, `packages/backend/public` rebuilt with the default port) | 7 passed                                                                                                                                   |
| Frontend e2e (`test:e2e`)                                                                                                                                               | not run: no UI touched                                                                                                                     |

## Notes for Next Session

1. Merge the feature PR, then a PR flipping feat-059 to `done`
2. feat-060 (One-Time Token Race) depends on this feature and is next; feat-061 (session token cache) only if the benchmark above is judged too expensive
