# feat-173 — Knowledge Base Routes Contracts (C4.2)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (C7, C4, C8, C5b, C6), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (C4.2). Depends on feat-169.

## State

Done, waiting for review and merge.

## What changed

- Ten routes of `/admin/knowledge-base/*` are on contracts:
    - list, get, create, update, delete, delete screenshot, reindex, reindex-all, init, init-status;
    - `shared/contracts/knowledge-base.ts` (`knowledgeBaseContracts`) and
      `app/routes/contract-schemas/knowledge-base.ts`;
    - the screenshot upload is multipart and stays for feat-177.
- Frontend:
    - `adminKnowledgeBaseApi` calls `callApi`, and `DIRECT_HTTP_CALLS` goes 33 → 24;
    - the local `KnowledgeBaseArticle` interface is now the shared `SupportKnowledgeBaseItem`
      (new type export in `shared/responses`);
    - the bodies of create and update are the shared input types.
- **What the types found:**
    - the `update` wrapper allowed `category: null`, which the schema refuses (422);
    - no caller sent it; the type is now the schema's.
- `isSuccessfulResponse` in `utils/api.ts` now narrows the answer to its success branch. It already
  checked `status !== 'error'` at run time; the type did not say so, so a contract response could
  not be read after it.
- `utils/admin-query.ts` (`adminQueryString`) has no caller left and is deleted with its three
  unit tests. `buildQuery` of the contracts does the same, and `shared` tests it.
- **Encoding change:** the query of the list request now encodes a space as `%20`
  (`encodeURIComponent`) instead of `+` (`URLSearchParams`). The server reads both the same way
  (`new URLSearchParams(req.getQuery())`); the expected URL in `admin-query.spec.ts` changed.
- Docs (both locales): `backend/routing.md`, the list of routes on contracts.

## Evidence of Completion

- `make check`: backend 2656, frontend 496 (−3: the deleted `adminQueryString` tests), shared 30,
  playground 111; bundle graph: 495 modules, no schema.
- `pnpm --filter backend test:pg` (with `REDIS_TEST_URL`): 295 passed.
- `pnpm --filter frontend test:e2e`: 92 passed.
- `pnpm docs:build && pnpm docs:verify`: passed.

### Not verified

- The knowledge base admin page against a running backend. The unit tests of the view mock the API.
