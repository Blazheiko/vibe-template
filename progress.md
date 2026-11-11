# feat-174 — Core, Prompts, Support Contracts (C4.3)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (C7, C4, C8, C5b, C6), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (C4.3). Depends on feat-173.

## State

Done, waiting for review and merge.

## What changed

- Ten routes on contracts, three new contract groups in `shared/contracts` with their registry
  files:
    - `mainContracts`: `/ping`, `/ready` (outside every group; `ok` / `unavailable` in one
      schema), `main/init`, `main/update-ws-token`;
    - `promptContracts`: `prompts`, `prompts/:type` (GET, PUT), `prompts/:type/test`, with no
      frontend caller;
    - `supportContracts`: `support/chat/history` GET (query `before`) and DELETE.
- Frontend:
    - `mainApi` and `supportApi` call `callApi`; `DIRECT_HTTP_CALLS` goes 24 → 20;
    - the local `SupportChatMessage` interface is now the shared `SupportChatHistoryItem` (new type
      export);
    - the history call passes its `signal` as before, and `before` is now encoded by `buildQuery`.
      The old code put it into the URL as typed; the schema accepts only digits, so nothing
      changes for a valid id.
- New `api-core-support.spec.ts`: the requests of `mainApi` and `supportApi` (method, URL,
  `before`, the signal) and how a page and a failure are read.
- Docs (both locales): `backend/routing.md`, the list of routes on contracts.

## Evidence of Completion

- `make check`: backend 2656, frontend 500, shared 30, playground 111; bundle graph: no schema.
- `pnpm --filter backend test:pg` (with `REDIS_TEST_URL`): 295 passed.
- `pnpm --filter frontend test:e2e`: 92 passed; `test:e2e:live`: 13 passed (sign-in, `main/init`,
  the support chat history).
- `pnpm docs:build && pnpm docs:verify`: passed.

### Not verified

- `prompts/*` has no frontend caller; only its backend side and its types are checked.
