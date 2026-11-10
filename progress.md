# feat-151 — WS Client Close Handling (V05)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V05), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (V05.S–V05.X). Finding M8 of
`docs/plan/code-review-2026-11-10-report.md`.

## Goal

The frontend handled the close event of every socket as a lost connection — also of a socket it
closed itself (a sign-out) or replaced with a new one (a token refresh over a live connection).
After a sign-out it reconnected five seconds later with the revoked token and pulled the user
back to `/login`; after a replacement the late close event of the old socket rejected the requests
of the new one and scheduled a reconnect that tore the healthy socket down.

## State

Done, waiting for review and merge.

## What changed

- `packages/frontend/src/composables/useWebSocketConnection.ts`
    - `retireCurrentSocket()` marks the current socket in a `WeakSet` before `websocketClose()`
      closes it and before `websocketOpen()` replaces it, rejects its pending requests and clears
      the "opened" flag at that moment.
    - The close event of a retired socket is ignored: no `resetApiResolve`, no reconnect timer,
      no token refresh, `isInitialized` untouched.
    - A close by the heartbeat (no pong) is not retired by the app and is still a lost connection.
- `packages/frontend/src/utils/websocket-close.ts` — `resolveWebSocketCloseAction` has a fourth
  argument `retiredByClient` and a new action `ignore`.
- Tests: `composables/__tests__/useWebSocketConnection.spec.ts` (7, new — a fake `useWebSocket`
  that keeps vueuse's order of events), `utils/__tests__/websocket-close.spec.ts` (+6),
  `e2e-live/ws-close-after-logout.spec.ts` (1, new).
- Docs (both locales): `backend/websocket.md`, the client's close handling.

## Evidence of Completion

### V05.T — RED (before the fix)

`pnpm exec vitest run src/composables/__tests__/useWebSocketConnection.spec.ts`:

```
 × does not reconnect or refresh the token after websocketClose (a sign-out)
   AssertionError: expected 2 to be 1                       (sockets opened)
 × keeps the requests of the new socket when the close of the replaced one arrives
   AssertionError: expected 'rejected' to be undefined      (WsDeliveryUnknownError: WebSocket connection reset)
 × rejects the requests of the old socket at the moment it is replaced
 × classifies a refused handshake of the new socket on its own, not by the old one
 Tests  4 failed | 3 passed (7)
```

The three tests of a really lost connection (a drop of the current socket, a heartbeat close,
pending requests rejected) were green before the fix and stay as regression tests.

In a real browser, `e2e-live/ws-close-after-logout.spec.ts` on the old composable:

```
 ✘ a sign-out does not reconnect the WebSocket or pull the user back to /login (8.4s)
   Expected: "/register"
   Received: "/login"
```

### After the fix

- Composable spec 7 passed; `websocket-close.spec.ts` passed.
- `pnpm format:check`, `pnpm typecheck`, `pnpm lint`: clean.
- `pnpm test`: frontend 36 files / 426 tests, backend 2597, api-playground 62.
- `pnpm --filter frontend test:e2e`: 87 passed.
- `pnpm --filter frontend test:e2e:live`: 9 passed, three runs in a row on the fix build (the new
  scenario: after a sign-out and a move to `/register`, 6.5 s later the page is still `/register`,
  no WebSocket was opened and `main/update-ws-token` was not requested).
- `pnpm docs:build && pnpm docs:verify`: passed.

### Not verified / seen along the way

- The replacement case (a password change over a live socket) is covered by the composable test
  with controlled events, not by a browser scenario.
- One live run on the fix build failed in `registration.spec.ts`: the page of the verification
  link showed "Service temporarily unavailable" (a 503 from the backend for an anonymous request,
  no WebSocket involved). The next three full runs were green. Recorded in the review report
  under "found while executing the plan" together with the same kind of 503 seen in feat-148.

## Notes for Next Session

- feat-152 (V06, support chat stream recovery) and feat-162 (V16) depend on this feature and
  change the same composable.
