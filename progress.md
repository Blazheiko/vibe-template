# feat-138 — Lifecycle and Timeout Lows (sixth review I5)

## State

Done on branch `fix/feat-138-lifecycle-timeouts`; start PR #446. Waiting for CI on the feature PR.

## Changes

- **L12** `ws-handlers.ts`: `closeAllWs` clears `acceptingUpgrades`; an upgrade that finishes its
  token check after that answers `503 Server is shutting down` instead of opening a socket.
  `ws-coordinator.ts`: the running `user_online` disconnect UPDATEs are tracked;
  `drainDisconnects(timeoutMs)` waits for them. `index.ts` drains them (3 s) after closing the
  sockets and before `pool.end()`.
- **L13** `push-notification-sender-service.ts`: `webpush.sendNotification` gets
  `{ timeout: PUSH_SEND_TIMEOUT_MS }` (10 s); still no proxy or agent.
- **L14** `readiness-probe.ts`: `probeTimeouts` splits the budget between the connection and the
  query, so a probe ends within `READINESS_CHECK_TIMEOUT_MS` instead of about twice that. The
  local `readiness-probe.pg.test.ts` case "a statement that does not answer", which failed locally
  on main before, now passes: the doubled budget was what pushed it past its deadline.
- Docs: `deployment.md`, `websocket.md`, `configuration.md`, `observability.md`,
  `web-push-notification.md`.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean
- `pnpm test`: backend 2535, frontend 400, api-playground 62; docs build + verify
- local test:pg 173 passed (readiness file 4/4)
- Mutation: main `ws-handlers.ts`, `ws-coordinator.ts`, the push sender and `readiness-probe.ts`
  → 8 new cases fail.
