# feat-197: WS Connection Limits

Plan: `docs/plan/security-review-2026-11-12-plan.md`, S03. Findings: M-4, L-11, L-13 of
`docs/security/security-review-2026-11-12.md`. Decision Д1: 10 connections per user, 50 per IP,
an extra upgrade gets 429. Branch: `fix/ws-connection-limits`.

## Current State

Done, in review.

- **M-4, connection limit.** `ws-connection-limit.ts` counts the open connections of a user and
  of an IP address on the instance. The upgrade takes a place right before `res.upgrade` (the
  check and the count are one synchronous step) and `onClose` gives it back. Over
  `WS_MAX_CONNECTIONS_PER_USER` (10) or `WS_MAX_CONNECTIONS_PER_IP` (50) the upgrade is answered
  429 with `Retry-After: 5`; 0 switches a limit off.
- **M-4, unknown events.** An event no route answers is answered `not_found` in `onMessage`,
  before the session read (it used to cost a Redis command and a query on the session-check
  pool, with no route limit). After feat-196 a message costs no Redis command for the token
  either.
- **L-11.** The first binary frame closes the connection with 1003 and one `warn` line; it used
  to be dropped before the message budget, with an `error` line each.
- **L-13.** The per-route WS limit is keyed by user, not by IP.
- The message budget stays per connection (decision Д1); with at most 10 connections a user has
  at most 10 budgets.

## Files Modified

- `packages/backend/src/vendor/utils/rate-limit/ws-connection-limit.ts` (new) and its spec
- `packages/backend/src/vendor/utils/routing/ws-route-lookup.ts` (new; shared by the dispatcher)
- `packages/backend/src/vendor/utils/network/ws-handlers.ts`, `vendor/utils/rate-limit/ws-rate-limit.ts`,
  `vendor/utils/routing/ws-api-dispatcher.ts`, `vendor/types/types.d.ts`
- `packages/backend/src/config/websocket.ts`, `.env.example`
- tests: `ws-upgrade-connection-limit.spec.ts` (new), `ws-rate-limit.spec.ts`,
  `ws-message-budget.spec.ts`, `ws-registry-lifecycle.pg.test.ts`, `config/websocket.spec.ts`,
  `validate-runtime-config.spec.ts`; four WS specs got a route map (an unknown event no longer
  reaches the session read)
- docs uk+en: `backend/websocket.md`, `backend/security.md`, `backend/configuration.md`

## Evidence of Completion

- `make check`: passing (backend 2764, frontend 549, playground 115).
- `pnpm docs:build && pnpm docs:verify`: passing.
- `pnpm --filter backend test:pg` (31 files, 307 passed) and `test:redis` (11 files, 116
  passed) on real services. On the real uWS server: the eleventh connection of a user is
  refused and accepted once one closes; a binary frame closes the connection with 1003.
- RED: with `ws-handlers.ts` and `ws-rate-limit.ts` as on `main`, 11 of the new unit tests fail
  (connection limit, unknown event without a session read, binary frame, per-user route key).

- Real stack: the whole `e2e-live` suite, 14 of 14 passed in 47 s. Two earlier runs of it are
  not evidence either way: the machine slept in the middle (tests of 16 minutes, then a web
  server that did not start in 90 s).

## Notes for Next Session

The WebSocket chain of the plan (feat-195, feat-196, feat-197) is complete. Next by priority:
feat-198 (sign-in method added notification, M-2) and feat-201 (in-flight body budget, M-3).
