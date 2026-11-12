# Progress: feat-184 Shared WS Envelope Type

## Current state

Done, in review.

- `packages/shared/src/ws-client/envelope.ts` holds the envelope types and one dependency-free helper:
    - `WsRequestEnvelope`, `WsReplyEnvelope` (with `WsReplyStatus`, which is the HTTP status as text or `'error'`), `WsBroadcastEnvelope`, `WsErrorBody`, `WsConnectionEstablishedData` and `WsIncomingMessage`;
    - the helper `isWsBroadcast`.
- Backend: `WsMessage`, `WsResponseData` and `ErrorResponse` in `vendor/types/types.d.ts` are now aliases of the shared types. `makeBroadcastJson` builds a `WsBroadcastEnvelope`. `mapWsControllerError` writes the status as `${number}`.
- Frontend:
    - The local `WebsocketMessage` is removed. Replies are typed `WsReplyEnvelope` and broadcasts `WsBroadcastEnvelope`, and `WsReply<T>` is `WsReplyEnvelope<T>`.
    - The dispatcher hands a broadcast over by its envelope (`isWsBroadcast`) before it classifies the other messages.
    - Test fixtures now use the real server shapes: a refusal is `status: 'error'` with `data: null`, and a broadcast has no `timestamp`.
- Playground:
    - The local `WebsocketMessage` is removed, and the request it sends is `WsRequestEnvelope`.
    - Service events go through a `WsServiceHandlerName` map. The dead `pong` and `connection_closed` handlers are gone.
    - `connection_established` reads `data`; it used to read a `payload` the server does not send.
    - `service:error` is recognized by `error.code === 'unauthorized'`; it used to compare `status === 4001`, which the server never sends.
- Docs, both locales:
    - `backend/websocket.md`: new "Тип конверта" / "Envelope type" section;
    - `backend/controllers.md`: `status` is `WsReplyStatus`;
    - `shared/index.md`: `ws-client` now includes the envelope.

## Evidence of Completion

- `make check`: passing (backend 2680, frontend 515, api-playground 115, shared 31, documentation 26).
- `pnpm docs:build && pnpm docs:verify`: passing.
- `pnpm --filter frontend test:e2e`: 92 passed.
- `pnpm --filter frontend test:e2e:live` (PG 55433): 13 passed. This covers the support chat and the admin subscription over WS.
- New tests:
    - `shared/test/ws-client.test.js`: `isWsBroadcast` (RED before the module existed), and a check that `envelope.js` has no imports;
    - playground `ws-request-errors.spec.ts`: a broadcast becomes `lastMessage`, and `connection_established` arrives with `data`.

## Notes for Next Session

Both features requested on 2026-11-12 are finished.
