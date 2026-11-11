# feat-180 — WS Request Correlation (W1)

ADR: `docs/adr/0006-websocket-contracts.md` (decision 2, Д-WS1), tasks:
`docs/plan/ws-contracts-tasks.md` (W1.S–W1.X).

## State

Done, waiting for review and merge.

## What changed

- **Envelope.** `WsMessageSchema` accepts an optional `id` (`0 < string <= 64`). `WsMessage` and
  `WsResponseData` carry it.
- **Server: the `id` comes back in every reply to the request.**
    - The dispatcher echoes it on a reply, on `not_found`, on an exception and on a rate-limit
      refusal.
    - `onMessage` echoes it on an invalid envelope, an exception and `service_unavailable`.
    - It echoes only an id the envelope allows. A message without one gets a reply without one.
- **Frontend.**
    - `websocketApi` sends a new id (`newRequestId`: `crypto.randomUUID()` with a fallback) and waits
      under it.
    - `hasPendingRequest` and `settleApiResponse` match by id, so a reply without the id of a
      pending request settles nothing.
    - `Request already in progress` is gone: requests of one event no longer wait for each other.
    - The timeout and `WsDeliveryUnknownError` are unchanged.
- **Playground.** The same envelope and the same matching by id.
- **Docs (both locales).**
    - `backend/websocket.md`: the message protocol with `id`, and the client's matching.
    - `playground/index.md`: how a WS reply is recognised.

## Evidence of Completion

- RED: 16 new tests failed on the old code:
    - frontend 6: an id with every request; two requests of one event each get their own reply in
      reverse order; a reply without the pending id settles nothing; the helpers match by id;
    - backend 8: id on a reply, `not_found`, exception, rate limit, invalid envelope, unexpected
      failure, `service_unavailable`; the envelope refuses an empty, too long or non-string id;
    - playground 2: two concurrent requests of one event, and an error reply with the id.
- After the fix: `make check` passed (backend 2673, frontend 504, shared 30, playground 112).
- `pnpm --filter backend test:redis` (with `REDIS_TEST_URL`): 116 passed.
- `pnpm --filter frontend test:e2e`: 92 passed on the second run. The first run lost only the login
  double-click test (HTTP, known flaky, untracked by the owner's decision).
- `test:e2e:live`: 13 passed (the support chat and the admin presence subscription go over WS).
- `pnpm docs:build && pnpm docs:verify`: passed.
