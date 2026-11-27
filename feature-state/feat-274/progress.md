# feat-274 · WS Context Without Session

Branch: `refactor/ws-context-session`. Plan: `docs/plan/ws-session-info-plan.md` (edition 5).
Registry PR: #892 (merged, `in_progress`). Status: implementation done, PR open.

## Changes

1. **wsSessionHandler** (`vendor/utils/session/session-handler.ts`) answers only the verdict
   `{ kind: 'ok' } | { kind: 'missing' } | { kind: 'unavailable' }`. The `Session` object with
   mutating methods it built on every message (and the dispatcher dropped) is gone, with the
   imports only it used (`updateSessionData`, `changeSessionData`, `consumeSessionData`,
   `updateSessionAuth`, `destroySession`, `sessionExists`, types `Session`, `SessionData`). The
   checks are unchanged: token format, the record (`getSession` still renews the sliding TTL and
   checks the max age), a non-empty `userId`, the `sessionToken` current in PostgreSQL.
2. **Dispatch path**: `ws-handlers.ts` calls the dispatcher without a session;
   `ws-api-dispatcher.ts` and `createWsContext` take none (the commented-out line is gone).
3. **WsContext** (`types.d.ts`) has no `session` / `auth`; `userData` documents that it is the
   object of `ws.getUserData()`. `pnpm typecheck` found no reader of the two fields.
4. **Tests**
    - `ws-session-handler.spec.ts`: exact `{ kind: 'ok' }` with the `getSession` and token-check
      arguments; new cases for an invalid `userToken` format (no session read) and a session
      without / with an empty `userId` (no token check). The storage mock keeps the functions
      `RequestSession` imports.
    - `ws-redis-unavailable.spec.ts`: `missing` → 4001 and no dispatch; `ok` → dispatched without a
      session argument.
    - `ws-close-lifecycle.spec.ts`: the race of feat-128 also asserts no dispatch; ok mocks.
    - `ws-message-budget.spec.ts`, `ws-message-errors.spec.ts`: ok mocks.
    - `ws-validation.spec.ts`, `ws-error-envelope.spec.ts`, `ws-request-id.spec.ts`: the dispatcher
      called without the session argument.
    - New `vendor/utils/context/ws-context.spec.ts`: `@ts-expect-error` on `context.session` and
      `context.auth`; at runtime `'session' in context` and `'auth' in context` are false,
      `context.userData` is the object passed in.
    - Unchanged on purpose: `ws-upgrade-*.spec.ts`, `vendor/start/*.transport.spec.ts`,
      `session-revocation.pg.test.ts`, `session-store.redis.test.ts` (only `.kind`); heartbeat and
      unknown-route coverage in `ws-message-budget.spec.ts`.
5. **Docs** (both locales):
    - `backend/auth.md`: the WebSocket callout (no `session` / `auth` on WsContext); the
      unavailable case (upgrade: HTTP 503 + `Retry-After: 1`, message: envelope
      `service_unavailable`, connection open); step 4 with the order of the checks and the verdict.
    - `backend/controllers.md`: WsContext block, HTTP/WS table (session row, `parseUserId`),
      "WsContext in detail" (order of the checks, authorization reads `userData`),
      `ws.getUserData()` and the closed-socket caveat (feat-107), `userData` table: `auth` row,
      "do not log" on `sessionId` / `userToken`, `parseUserId` instead of `asUserId`, the example
      as in `support-controller.ts`.
    - `backend/request-lifecycle.md`: diagram (`UpgradeTokenResult`, route lookup before
      `wsSessionHandler`, no session to the dispatcher), the Messages item (binary → 1003, route
      lookup, verdicts), the Dispatcher item.
    - `backend/websocket.md`: the per-message check is for known routes after the envelope check;
      a logout on the same instance closes the sockets at once (`ws-session-revocation`).
6. **pending / recovery** (plan conclusion re-confirmed): the pending record is written under
   `plan.sessionId` of the planned session (`request-session.ts`, `planRecord`); a recovery session
   opens no WebSocket (`main/init` answers `wsToken: null`) and ends the other sessions
   (`documentation/backend/mfa.md`, recovery code). No transition of an open connection was found;
   left out.

## Evidence of Completion

- `./init.sh` on the baseline (origin/main 23f0bb2): exit 0.
- `make check`: exit 0 (backend 269 files / 3942 tests, frontend 83 files, landing 6 files,
  api-playground 11 files, shared 162, documentation 26, rule tests 30).
- `pnpm docs:build && pnpm docs:verify`: passed.
- PG and Redis suites: not run locally (the PostgreSQL / Redis on this machine belong to another
  project). CI of PR #893 (first push of the branch):
    - `test-pg`: 72 files / 724 passed, 0 skipped
      (https://github.com/Blazheiko/vibe-template/actions/runs/46006549050/job/140531030107);
    - `test-redis`: 22 files / 231 passed, 0 skipped
      (https://github.com/Blazheiko/vibe-template/actions/runs/46006548915/job/140531030379);
    - `quality`, `e2e`, `e2e-live`, `build`: green
      (https://github.com/Blazheiko/vibe-template/actions/runs/46006548772).
- Manual golden path (`make dev-playground`): **not done yet**, needs this project's services.
  Steps: sign in, `support` / `admin` WS events answer as before; HTTP logout in another tab closes
  the socket with 4001 at once (ws-session-revocation); optionally `redis-cli DEL
session:<userToken>:<sessionId>` with the socket open, then a known-route event → 4001 (the
  `missing` branch).

## Review of #893 (COMMENT, c244ead7)

- No regressions in the code. Medium: `auth.md` (both locales) still said that every WS message
  checks the token (revocation list) and the session's max age. Both places now say the check runs
  for a message of a known route after the envelope format check, and that `ping` and unknown
  events do not read the session; an expired session closes the connection with 4001 on the next
  such message. The same precision in `controllers.md` ("WsContext in detail": the context is made
  only for a message that reaches the dispatcher). `docs:build` + `docs:verify` and
  `format:check` passed.

## Notes for Next Session

- Do the manual check (needs this project's PostgreSQL / Redis on 5432 / 6379).
- Then: status PR `feat-274` → `review`, review, merge, "Mark feat-274 done".
