# feat-171 — WebSocket Contracts (C6, design)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (C6), task C6.1. Design only: no code.

## State

Done, waiting for review and merge. Implementation is three features, `feat-180`…`feat-182`
(not started). They wait for the owner's decisions Д-WS1…Д-WS3.

## What changed

- [ADR 0006](docs/adr/0006-websocket-contracts.md) (status: proposed) describes the current state
  read from the code:
    - four WS routes with schemas on the route, called by string with an untyped reply;
    - requests correlated by event name, so only one request per event can be in flight;
    - broadcast schemas checked on the server, with hand-written guards and a parity test on the
      client;
    - two server-side `service:*` events, with dead `pong` and `connection_closed` handlers on the
      client.
- The ADR's design:
    - WS request contracts (`wsContract`, registry entries `ws <event>`, `defineWsRoute({ contract })`,
      `callWs`);
    - a request `id` echoed by the server (Д-WS1);
    - broadcast type contracts with an exhaustive guard registry (Д-WS2);
    - `service:*` as a type in `shared/ws-client` (Д-WS3);
    - alternatives (JSON-RPC 2.0, AsyncAPI, timestamp correlation, schemas in the bundle, a
      separate WS registry), consequences and an estimate.
- [docs/plan/ws-contracts-tasks.md](docs/plan/ws-contracts-tasks.md): W1 (correlation, S), W2
  (request contracts, M), W3 (broadcast, S), each task with acceptance criteria.
- `feature_list.json`: `feat-180` W1, `feat-181` W2, `feat-182` W3, `not-started`, chained by
  dependencies.
- C6.1 ticked in the review task list.

## Evidence of Completion

- Every statement about the current code in the ADR was checked against `main`:
    - `ws-routes.ts`, `define-ws-route.ts`, `ws-api-dispatcher.ts`, `ws-message-validator.ts`,
      `ws-handlers.ts` (`ping`/`pong`, `service:*`);
    - `useWebSocketConnection.ts` (`apiResolve[event]`, `Request already in progress`),
      `useBroadcastHandler.ts`, `ws-payload-guards.ts` and its parity test;
    - `broadcast-events.ts`, `shared/ws-client`, the playground's WS client, and `baseApi.ws` (no
      callers).
- `pnpm format:check`: clean. No code changed, so typecheck, lint and tests are not affected.
