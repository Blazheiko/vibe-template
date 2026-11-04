# feat-107 — WS Registry Lifecycle

Plan: `docs/plan/code-review-2026-11-03-plan.md`, item R04 (findings 4, 17). Branch: `fix/feat-107-ws-registry-lifecycle` (from `main` after #354).

## Current State

Implemented; PR open.

- A uWS socket is dead once its `close` handler runs; every access after that throws. `idleTimeout: 120` closes half-open connections through the same handler, so no extra heartbeat is needed.
- `ws-handlers.ts` `onClose`, before its first await:
    - reads `userData`, sets `userData.closed = true`, drops the socket from `wsStorage`;
    - starts `onDisconnected`, whose synchronous part unregisters the connection;
    - only then awaits the Redis `onRevokeToken`, and then the disconnect.
- `ws-coordinator.ts` `handleConnected`: after `await findRole`, returns when `userData.closed`, so a socket closed meanwhile never enters the registry.
- `ws-connection-registry.ts`: each connection is stored with its own `ip`, `userAgent` and `appType`; `summarizeAppType` and `getOnlineUserMeta` no longer call `ws.getUserData()` on stored sockets.
- `sendJson`: a `ws.send` result of `2` (dropped over `maxBackpressure`) logs a `warn` and closes with `1013 Backpressure`; `0` and `1` keep the socket.
- `UserConnection.closed?: boolean` (`vendor/types/types.d.ts`).
- Docs: `documentation/backend/websocket.md`.

## Files Modified

- `packages/backend/src/vendor/utils/network/ws-handlers.ts`, `src/vendor/types/types.d.ts`
- `packages/backend/src/app/websocket/ws-coordinator.ts`, `ws-connection-registry.ts`
- New tests:
    - `packages/backend/src/vendor/utils/network/ws-close-lifecycle.spec.ts`
    - `packages/backend/src/app/websocket/ws-registry-lifecycle.spec.ts`
    - `packages/backend/src/app/websocket/ws-registry-lifecycle.pg.test.ts`
- `documentation/backend/websocket.md`

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 2242, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` locally: 17 files / 136 tests passed, 5 files skipped by their own conditions.
- `test:redis` locally: 9 files / 91 passed.
- Unit (`ws-close-lifecycle.spec.ts`, `ws-registry-lifecycle.spec.ts`):
    - order is disconnected → revoke started → revoke done;
    - a failing `onDisconnected` still revokes;
    - a send dropped by backpressure closes with 1013, while 0 and 1 do not;
    - a socket closed during `findRole` is never registered;
    - a reload registers the new socket while the dead old one is still stored;
    - summaries never read stored sockets.
- Real server (`ws-registry-lifecycle.pg.test.ts`: real uWS, routes, Redis sessions, PostgreSQL):
    - the old socket's token revoke is held;
    - the old socket is already out of the registry;
    - a new socket for the same user registers, and `broadcastMessageToUser` returns 1 and reaches it.
- Mutation check: with `main`'s `ws-handlers.ts`, coordinator and registry, every new case fails. That is the 4 unit cases plus the two registry cases after the reload test was strengthened, and the real-server case, which fails at "old socket still in registry while Redis is pending".

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next by the plan order: R05 (mail escaping and OAuth fetch).
