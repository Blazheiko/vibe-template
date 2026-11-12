# feat-182 — Broadcast Contracts (W3)

ADR: `docs/adr/0006-websocket-contracts.md` (decisions 3 and 5), tasks:
`docs/plan/ws-contracts-tasks.md` (W3.S–W3.X). Depends on feat-181.

## State

Done, waiting for review and merge.

## What changed

- **W3.1:** `shared/contracts/broadcast.ts` adds `BroadcastContracts`, a types-only map
  event → payload over `BroadcastEventSchemas`. The bundle graph is still schema-free.
- **W3.2:**
    - The guard registry `broadcastGuards` in `ws-payload-guards.ts` is typed
      `satisfies BroadcastGuards`, so an event of the schema registry without a guard does not
      compile. The parity test uses that same registry instead of a copy.
    - The event bus types its broadcast events from `BroadcastContracts`. The five hand-written
      payload types in `event-bus.ts` are gone.
    - `useBroadcastHandler` is generic: it checks the payload with the event's guard, then emits it
      under the event's name. A refused payload is reported. An unknown or inherited key such as
      `constructor` is ignored. The five hand-written handlers that copied fields one by one are
      gone.
    - **Not done as written in the task list:** there is no separate `onBroadcast(event, handler)`.
      `useEventBus().on(event, handler)` is already the typed subscription, so a second API for
      the same thing would add nothing.
- **W3.3:**
    - `WsServiceEvent` / `WsServiceHandlerName` in `shared/ws-client`.
    - The client's service handlers are a complete `Record<WsServiceHandlerName, …>`.
    - The dead `pong` and `connection_closed` handlers are removed: the server sends neither, and
      the heartbeat is the plain text `ping` / `pong`.
- **Docs, both locales:**
    - `backend/websocket.md`: adding a broadcast on the frontend, the event contract, service
      events;
    - `shared/index.md`.

## Evidence of Completion

- New `useBroadcastHandler.spec.ts`:
    - each of the five events reaches the bus with its payload;
    - a refused payload is reported and dropped;
    - an unknown event and `constructor` are ignored;
    - compile-time: a guard registry without an event does not compile.
- This is a refactor with a type guarantee. The runtime behaviour was the same before (same keys,
  guard first), so the new runtime tests were not RED on the old code.
- `make check`: backend 2680, frontend 515, shared 30, playground 113; bundle graph: 502 modules,
  no schema.
- `pnpm --filter frontend test:e2e`: 92 passed on the second run. The first lost only the known
  flaky login double-click test (HTTP).
- `test:e2e:live`: 13 passed (support chat streaming events, admin presence).
- `pnpm docs:build && pnpm docs:verify`: passed.
