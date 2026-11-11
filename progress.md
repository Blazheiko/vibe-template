# feat-172 — Route Contract Schema Registry (C7)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (C7, decision C1.R), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (C7.S–C7.X). ADR 0005, decision 6.

## State

Done, waiting for review and merge.

## What changed

- **C7.1 decision:** the registry lives in the backend
  (`app/routes/contract-schemas/`, generic code in `app/routing/contract-registry.ts`). It is
  keyed by `<method> <path>` of the contract. Reasons are in ADR 0005, decision 6: binding the
  schemas is a server concern; the playground gets schemas from `/doc/routes`; outside `shared` the
  frontend cannot import it by mistake.
- **C7.2:**
    - `contractSchemas(group, entries)` needs an entry for every contract of the group and checks
      each one against its contract. These are the pilot's checks, moved from the route fields to
      the entries.
    - `contractRouteDefiner(registry)` makes the `defineContractRoute` of a registry: method and
      path come from the contract, `validator` / `queryValidator` / `ResponseSchema` from the entry.
    - The handler's payload and query are typed as the outputs of the entry's schemas. Before, the
      query was typed as the schema's morph type.
    - A contract with no entry is a compile error, and the server refuses to start with
      `Route contract … has no entry in the schema registry`.
    - The old `defineContractRoute` with schemas on the route is removed (no compatibility: template).
- **C7.3:** the 12 pilot routes name only `contract`, `handler` and their server settings; five
  schema imports left `http-routes.ts`.

Docs: ADR 0005 (decision 6, sections 4 and the target state), `backend/routing.md` and
`backend/adding-a-feature.md` in both locales. The global `backend-feature` skill
(`~/.claude/skills`) does not describe contracts and is outside the repository; it is updated with
C5b, when there is one `defineRoute`.

## Evidence of Completion

- `define-contract-route.spec.ts` covers:
    - runtime: the registry keys, a route built from the registry, refusing a contract with no
      entry, route groups;
    - compile-time negative checks, every one `@ts-expect-error` and all used: an entry with
      another route's body schema; missing body schema; body schema for a contract with no body;
      another response schema; query schema with other keys; missing query schema; a contract of
      the group with no entry; a route whose contract has no entry; a handler answering outside the
      schema; a payload field that does not exist.
    - It also checks that the query a handler sees is the parsed output.
- Serialized routes (`serializeRoutes(http-routes)`, what the playground shows): byte-for-byte
  identical to the old route table (233 452 bytes).
- `make check`: backend 2656, frontend 499, shared 30, playground 111;
  `check-bundle-graph: 495 modules, no schema and no validator library`.
- `pnpm --filter backend test:pg` (with `REDIS_TEST_URL`): 295 passed.
- `pnpm --filter frontend test:e2e` 92, `test:e2e:live` 13.
- `pnpm docs:build && pnpm docs:verify`: passed.

### Not verified

- The compile time of a large registry. Using an intersection with `SchemaEntry` in the group
  type made ArkType types instantiate too deeply (TS2589), so the group type keeps the entries'
  own types. With 12 entries `tsc` shows no slowdown; this needs watching as C4 adds about 50.
