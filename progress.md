# feat-133 — Failed onConnected Closes the Socket (P3)

## State

Done on branch `fix/feat-133-ws-connected-failure`; start PR #432. Waiting for CI on the feature PR.

## Changes

- `vendor/utils/network/ws-handlers.ts`: when the `onConnected` hook fails (e.g. a database error in
  `findRole`, before `registerConnection`), `onOpen` closes the socket with `1011 Server error`
  unless it already closed. Before, the error was only logged: the client had
  `connection_established`, the socket stayed open outside the registry, broadcasts never reached
  it, `isUserOnline` said false (pushes as if offline), and the client never reconnected.
- Docs: `documentation/backend/websocket.md`.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean
- `pnpm test`: backend 2508, frontend 400, api-playground 62; `pnpm docs:build && pnpm docs:verify`
- Reproduced before the fix with a throwaway test on the real onOpen, ws-coordinator and registry
  (findRole rejects): connection_established sent, error only logged, no end/close, not registered.
- Mutation: main `ws-handlers.ts` → the 1011 case fails; the closed-socket case is a guard.
- Frontend reconnects on every code outside 4000–4099 (`useWebSocketConnection.ts`).
