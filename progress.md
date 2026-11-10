# feat-149 — WS Message Budget (V03)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V03, decision Д2: 120 messages a minute per
connection and 8 concurrent handlers), tasks: `docs/plan/code-review-2026-11-10-tasks.md`
(V03.S–V03.X). Finding M1 of `docs/plan/code-review-2026-11-10-report.md` and the low finding
about `Object.prototype` members resolved as WS routes.

## Goal

A valid WebSocket message, an unknown event included, ran the token refresh (Redis) and the
session check (Redis + PostgreSQL) before any rate limit; `ping` and malformed messages cost a
Redis command each and were never limited. A connection now has a budget that is checked first,
from memory.

## State

Done, waiting for review and merge.

## What changed

- `vendor/utils/rate-limit/ws-message-budget.ts` (new): per-connection state in `userData`
  (`messageBudget`), a fixed one-minute window.
    - messages other than `ping`: `WS_MESSAGES_PER_MINUTE` (120);
    - handlers of the connection running at once: `WS_MAX_CONCURRENT_HANDLERS` (8);
    - `ping`: 60 a minute, counted apart; over it the pong is still sent, the token is not
      refreshed;
    - close with `4029` when more frames were refused within a minute than the budget itself
      (more than twice the budget sent), or in the third minute in a row over the budget.
- `vendor/utils/network/ws-handlers.ts`: `onMessage` checks the budget before `refreshToken`; a
  refused message is answered `rate_limited` with the request's event when it can be read; the
  handler slot is released in `finally`.
- `config/websocket.ts`: `WS_MESSAGES_PER_MINUTE`, `WS_MAX_CONCURRENT_HANDLERS`; an invalid value
  throws at startup.
- `vendor/start/router.ts`, `vendor/utils/routing/ws-api-dispatcher.ts`: the WS route map has no
  prototype and the lookup takes own properties only.
- Docs (both locales): `backend/websocket.md` (new section "Connection message budget", error
  table, close codes), `backend/configuration.md`; `packages/backend/.env.example`.

The window is fixed, not sliding (the plan said "sliding"): a fixed window needs no per-message
history, and the close rule already bounds what a burst across a window edge can cost.

## Evidence of Completion

### V03.T — RED (before the fix)

`pnpm exec vitest run src/vendor/utils/network/ws-message-budget.spec.ts` (budget mocked to 20):

```
 × checks the session for valid messages only until the budget is used up
   AssertionError: expected "vi.fn()" to be called 20 times, but got 30 times
 × never checks the session for malformed JSON, and stops the Redis refresh at the budget
   AssertionError: expected "vi.fn()" to be called 20 times, but got 30 times
 × never checks the session for ping, always answers pong, and stops the Redis refresh at the ping budget
   AssertionError: expected "vi.fn()" to be called 60 times, but got 70 times
 Tests  8 failed | 2 passed (10)
```

As the report's revision 2 says, `ping` and malformed JSON never reached the PostgreSQL check
before the fix either (those assertions were green and stay as regression tests); what was
unbounded for them was the Redis refresh.

`pnpm exec vitest run src/vendor/utils/routing/ws-error-envelope.spec.ts`:

```
 × answers not_found for constructor, without an error log   (and __proto__, toString, hasOwnProperty, valueOf)
 Tests  5 failed | 6 passed (11)
```

### After the fix

- New specs: `ws-message-budget.spec.ts` 10 passed, `ws-error-envelope.spec.ts` 11 passed,
  `config/websocket.spec.ts` (new readers) passed.
- `pnpm format:check`, `pnpm typecheck`, `pnpm lint`: clean.
- `pnpm test`: backend 193 files / 2592 tests, frontend 35 files / 413 tests, api-playground 62.
- `pnpm --filter backend test:redis`: 116 passed.
- `pnpm --filter frontend test:e2e:live` (fresh build, real backend and WebSocket): 8 passed —
  sign-in, heartbeat and the session scenarios stay inside the default budget.
- `pnpm docs:build && pnpm docs:verify`: `verify-dist: all checks passed`.

### Not verified

- The report's hypothesis that a flood starves the session-check pool and gives other users 503
  was not load-tested, before or after the fix. What the tests show is that the cost per
  connection is now bounded.
- No browser run against a connection closed with 4029; the frontend rule for the code is
  covered by `websocket-close.spec.ts`.

## Notes for Next Session

- The numbers 120 / 8 / 60 are defaults by decision, not measurements.
- A connection closed with 4029 is not reopened by the client until the page is reloaded.
