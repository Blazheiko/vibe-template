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
