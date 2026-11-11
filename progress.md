# feat-167 — Route Contracts Design (C0)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (C0, decision Д6: an ADR), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (C0.S–C0.X).

## Goal

Fix the design of shared route contracts before the pilot: the package boundary, the input and
output types of a schema, the full shape of a call on top of the current transport, what stays
server configuration, and how a URL is built — and name the boundary for multipart.

## State

Done, waiting for review and merge.

## What is in this branch

- `docs/adr/0005-route-contracts.md` — the five decisions with examples for the three pilot
  routes, the multipart boundary, the rejected alternatives, and what the prototype showed.
- `packages/frontend/scripts/check-bundle-graph.mjs` and the script `check:bundle-graph` — the
  proof on the module graph of the production build that the browser bundle has no schema and no
  validator library. It holds today and is the gate for the pilot.

The prototype itself (contracts in `shared`, `defineContractRoute`, the typed client, twelve
migrated routes, the tests) is not in this branch: it is the starting point of feat-168 (C1).

## Evidence of Completion

- **C0.1 prototype.** Twelve routes moved to contracts (the `push-subscriptions` group, `GET
/admin/users`, `POST /auth/login`): `pnpm typecheck` clean; backend unit 2612 and PG 288 passed
  unchanged. Negative checks with `@ts-expect-error` compile on both sides (a wrong method is not
  expressible: the method is the contract's; a wrong body, params, query key, response field and a
  schema of another route do not compile).
- **C0.2 package boundary.** `pnpm --filter frontend check:bundle-graph`:

    ```
    check-bundle-graph: 492 modules, no schema and no validator library.
    ```

    Negative control: `import { LoginInputSchema } from 'shared/schemas'` as a value in
    `utils/api.ts` → exit 1, the ArkType modules are named. (A first negative control was put into a
    file the app does not import and proved nothing; it was redone in `utils/api.ts`.)

- **C0.3 input and output types.** `AdminUserListQuerySchema` parses `limit` from a string and
  fills a default: the client is typed with the explicit `AdminUserListQueryInput`, the handler
  with the schema's output; the server checks that the keys agree. Bodies use `inferIn`.
  The comparison of responses had to leave the error branch out: `WithCanonicalError` narrows it
  on purpose.
- **C0.4 ADR.** Covers the five decisions of the report and says what the client does with
  multipart routes (they stay on `baseApi.upload`).
- `prettier --check` and `eslint` on the new files: clean.

### Deviation from the plan

The plan wrote `defineRoute({ contract, handler })`. The prototype uses a separate
`defineContractRoute`: an overload of `defineRoute` changed how `Parameters<typeof defineRoute>`
is inferred in an existing test. Recorded in the ADR.

## Notes for Next Session

- feat-168 (C1) continues from the prototype kept in the stash `c1-prototype`.
- C1.7 adds `check:bundle-graph` to `make check` / CI.
