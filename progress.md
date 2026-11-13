# feat-210: WS Closes On Single-Session Logout

Follow-up to feat-195 and feat-209 (security review 2026-11-12, M-1), found by a review of
`main` @ `76c18a7`.

## Current State

Done, ready for review.

## The Gap

A logout of one session deletes its stored record in Redis and does not rotate
`users.session_token`. The periodic WS re-check and the check in `handleConnected` compared
only that token. So:

- a socket of the logged-out session held by **another instance** was never closed and kept
  receiving broadcasts;
- on the same instance, a logout that landed while `handleConnected` awaited its read found
  nothing in the registry, and the socket was registered afterwards.

## What Changed

- `recheckSessions` also asks Redis, one pipeline per 1000 sessions (`sessionsExist`), whether
  the stored session of every connection still exists, and closes the connections of those
  that do not. A Redis failure throws and closes nothing, like a database failure.
- The registry keeps the connections that are being opened (`beginConnecting` /
  `revokeConnecting`). `closeUserConnections` marks them before it closes the registered ones;
  `handleConnected` notes the connection before its reads, reads the role and the stored
  session together, and closes a connection that was marked, whose session is gone, or whose
  token was rotated.
- Docs uk + en: `backend/websocket` (revoking a session), `backend/configuration`.

## Files Modified

- `packages/backend/src/app/services/auth/ws-session-revocation.ts` (+ spec)
- `packages/backend/src/app/websocket/ws-coordinator.ts`, `ws-connection-registry.ts`,
  `ws-registry-lifecycle.spec.ts`
- `packages/backend/src/vendor/utils/session/redis-session-storage.ts`
- `packages/backend/src/app/services/auth/session-revocation.pg.test.ts`
- `documentation/backend/{websocket,configuration}.md` and the same pages under
  `documentation/en/backend/`

## Evidence of Completion

- `make check`: passed (backend 2978, frontend 583, api-playground 115).
- `pnpm --filter backend test:pg` with `PG_TEST_URL` and `REDIS_TEST_URL`: 33 files / 322 tests
  passed. `test:redis`: 117 passed.
- Live e2e: 15 passed. `pnpm docs:build && pnpm docs:verify`: passed.
- **Negative control.** With the four source files reverted: the PG test "the re-check closes
  the sockets of a session that another instance logged out" gets `expected 0 to be 2` (the
  gap, reproduced on real PostgreSQL and Redis), and 7 unit tests fail (stored session gone at
  the re-check and at connect, the mark of a logout during connect, a Redis failure).
- **Manual check on two real instances** (`scripts/prod-local.sh` on ports 3100 and 3102, one
  database and one Redis prefix, `WS_SESSION_RECHECK_INTERVAL_MS=2000` on the second): sign in
  through instance A, open a WebSocket on instance B with a token issued by A. The socket
  stays open through 5 s of re-checks. `POST /api/auth/logout` on A: instance B logs
  `WS connections closed … reason: "re-check"`, the client gets the `session_expired` error
  and close code 4001 about 3 s later. Instance A logged no close: it never held the socket.

## Notes

- The first live e2e run after the manual check failed (14 of 15): my two manual instances
  had rebuilt the SPA for another port. After a clean `prod-local.sh --build-only` the suite
  passed; the failure had nothing to do with the change.
- A socket of a session that expired in Redis (24 h without an HTTP request, the socket only
  pinging) is now closed by the re-check too. The client then asks for a new WS token over
  HTTP and, with the session gone, is signed out.

## Next Step

Merge, mark `feat-210` done on `main`, then `feat-211`.
