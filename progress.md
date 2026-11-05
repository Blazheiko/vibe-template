# feat-128 — Support Stream and WebSocket Lows (fifth review H2)

## State

Done on branch `fix/feat-128-ws-support-stream`; start PR #417. Waiting for CI (test-pg, test-redis,
e2e, e2e-live) on the feature PR.

## Changes

- `services/communication/broadcast-service.ts` (N3): `deliver` knows the event. A dropped
  `support_chat_token` (uWS `send` → 2) is logged at `debug` and does not end the connection: the
  token is a preview and `support_chat_complete` carries the whole reply (the frontend's
  `completeStreaming` uses its `content`). Ending the connection there made `onClose` abort the run,
  and the reply already paid for was neither saved nor sent. Any other dropped event, the final
  `support_chat_complete` included, still ends the connection with 1013; by then the reply is saved.
- `vendor/utils/network/ws-handlers.ts`: `closeExpiredSession` skips a socket that closed while the
  session lookup was awaited (it threw "Invalid access of closed uWS.WebSocket" into the error log).
- `app/websocket/ws-coordinator.ts`: the disconnect `UPDATE` of `user_online` waits for the connect
  `INSERT` to settle and runs whatever it answered; a failed INSERT may have committed (timeout,
  reset after COMMIT), and skipping the UPDATE left that row open. A connection closed before its row
  was tracked still writes nothing.
- `services/support/support-service.ts`: comment on the fallback updated.
- Docs: `documentation/backend/websocket.md`.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean
- `pnpm test`: backend 2409, frontend 400, api-playground 62, shared 25, documentation 26
- `pnpm docs:build && pnpm docs:verify` pass
- test:pg / test:redis: no local Docker; run by CI on the feature PR
- Mutation (main version of the three source files, new tests): 3 fail (dropped token keeps the
  connection, expired session after close, failed INSERT gets the UPDATE); all 32 pass with the fix.
- Manual: covered by the unit specs that drive the real `onMessage` / `handleConnected` /
  `handleDisconnected` with a uWS-like socket that throws after close.

## Notes for Next Session

Next group of the fifth review: H3 (L5 guard made required + wiring tests, resend-verification-email
and test-push, phone-reset two-completions test), then H4 (operations lows).
