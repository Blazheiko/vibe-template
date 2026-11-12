# feat-181 — WS Request Contracts (W2)

ADR: `docs/adr/0006-websocket-contracts.md` (decision 1), tasks: `docs/plan/ws-contracts-tasks.md`
(W2.S–W2.X). Depends on feat-180.

## State

Done, waiting for review and merge.

## What changed

- **W2.1, `shared/contracts`:**
    - kind and method `ws`;
    - `wsContract<Payload, Response>()(path)`, where the path is the event under the API prefix;
    - `shared/contracts/ws.ts` has `adminWsContracts` (subscribe/unsubscribe online users) and
      `supportWsContracts` (open chat, chat). The bundle graph stays free of schemas.
- **W2.2, the registry and the route:**
    - `app/routes/contract-schemas/ws.ts`, with entries keyed `ws <event>`;
    - `contractWsRouteDefiner` builds `defineWsRoute({ contract, handler, … })`, taking the event
      from the contract and the payload and reply schemas from the entry;
    - an HTTP contract is refused at compile time and at start;
    - `ws-routes.ts` declares its four routes by contract;
    - the schema-only helper is `defineRawWsRoute`, kept for the WS machinery tests; a root ESLint
      rule forbids importing it outside tests.
- **W2.3:** `route-contracts.spec.ts` also walks `ws-routes.ts`. A WS route without a contract,
  registry entry or reply schema fails it, and the registry check covers WS keys.
- **W2.4, frontend:**
    - `callWs(contract, payload?)` in `utils/ws-client.ts` settles as the connection does;
    - `SupportView.vue` and `AdminLayout.vue` use it;
    - `callApi` refuses a WS contract at compile time;
    - `baseApi.ws` is gone. It had no caller, and dropping it drops base-api's import of the WS
      composable.
    - One ESLint block forbids both `baseApi.http`/`upload` and `websocketApi(...)` outside their
      clients. It is one block because a second `no-restricted-syntax` block for the same files
      would replace the first one, not add to it.
- **Found on the way, a bug since the contract pilot (C1):**
    - The playground built a route's full URL as group prefix + `url`. For a contract route `url`
      is the whole contract path, so its forms sent `/api/admin/admin/users`.
    - The fix: `fullUrl` uses `contractPath` when there is one.
    - The serialized routes for HTTP contract routes did not change in this PR. For WS routes the
      serialized `url` is now the contract path, and `contractPath` is added.
- **Docs (both locales):**
    - `backend/websocket.md`: WS routes, "how to add a WS route" rewritten for contracts, the client;
    - `backend/routing.md`: the WebSocket section;
    - `backend/validation.md`: where a WS route takes its payload schema.
    - The global `backend-feature` skill (`~/.claude/skills`) has its WS step rewritten.

## Evidence of Completion

- RED:
    - the playground test of the full URL failed on the old store (`api/admin/admin/users`);
    - `route-contracts.spec.ts` for `ws-routes.ts` failed on routes declared without contracts.
- New compile-time checks:
    - backend: a WS entry with another event's payload schema; an HTTP contract in
      `defineWsRoute`; a payload field that does not exist;
    - frontend: `callWs` without its payload, with another request's field, with an HTTP contract;
      a reply field that does not exist; `callApi` with a WS contract.
- Runtime tests:
    - `callWs`: the event and payload it hands over, an empty payload, a business error resolves,
      a transport error rejects;
    - `defineWsRoute`: the keys, the event, the schemas, the group prefix check, refusing an HTTP
      contract.
- Both ESLint rules fire on throwaway files.
- `make check`: backend 2680, frontend 508, shared 30, playground 113; bundle graph: 502
  modules, no schema.
- `pnpm --filter backend test:redis` (with `REDIS_TEST_URL`): 116 passed.
- `pnpm --filter frontend test:e2e` 92 and `test:e2e:live` 13. The live suite runs the support
  chat (open, chat) and the admin subscription over WS.
- `pnpm docs:build && pnpm docs:verify`: passed.

### Not verified

- The playground's forms against a running backend: the full-URL fix is covered by the store
  test only.
