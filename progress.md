# feat-168 — Route Contracts Pilot (C1)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (C1), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (C1.S–C1.R). Design:
`docs/adr/0005-route-contracts.md`. Depends on feat-167, feat-148, feat-156.

## Goal

The pilot of shared route contracts on three kinds of route: a group with bodies and path
parameters (`push-subscriptions`, 10 routes), a route with a parsed query (`GET /admin/users`) and
a public auth route (`POST /auth/login`). A mismatch between the client and the server in method,
path, body, parameters or the shape of the answer becomes a `pnpm typecheck` error.

## State

Done, waiting for review and merge. The decision C1.R (start the migration of the other groups
or change the design) is the owner's and is open.

## What changed

- `packages/shared/src/contracts/` (new subpath `shared/contracts`): `core.ts` (`contract`,
  `buildPath`, `buildQuery`, `buildUrl`, the types), `push-subscriptions.ts`, `auth.ts`,
  `admin.ts`. Schemas are imported with `import type` only.
- Backend: `defineContractRoute` in `app/routing/define-route.ts` (method and path from the
  contract; the body, query and response schemas checked against its types); the router checks
  that a contract route sits in the group of its path. Twelve routes moved in `http-routes.ts`.
- Frontend: `utils/api-client.ts` (`callApi`) on top of `base-api.ts`; `pushSubscriptionApi`,
  `authApi.login` and `adminUsersApi.list` go through it. The local `PushSubscriptionData` /
  `PushSubscriptionResponse` types and the casts to `Record<string, unknown>` in `stores/push.ts`
  are gone.
- ESLint (frontend): no direct `baseApi.http` outside `utils/api-client.ts` and `utils/api.ts`;
  `utils/__tests__/api-direct-calls.spec.ts` keeps the number of direct calls left in
  `utils/api.ts` (36) from growing.
- `check:bundle-graph` is part of `make check` (and so of the CI `quality` job).
- Docs (both locales): `backend/routing.md` (new section), a note in `backend/adding-a-feature.md`.

### What the types found on the way

- `stores/push.ts` read `vapidPublicKey` and `subscription` without narrowing by `status`, and
  accepted a bare array from the list route, which the server never sends. With the contract
  types these no longer compile; the store reads the answers as they are, and the test fixtures
  got the real wire shape.
- The response check had to compare success branches only: `WithCanonicalError` narrows the
  error branch of the client type on purpose (ADR 0005, decision 2).

### Deviation from the plan

`defineContractRoute` is a separate function, not an overload of `defineRoute` (ADR 0005).
The ESLint exception is per file, so the calls left in `utils/api.ts` are held by a counting
test instead of an explicit list of calls.

## Evidence of Completion

- **Types.** `pnpm typecheck` clean. Negative checks compile with the specs (`@ts-expect-error`):
  client — a missing body, an extra field, a field of the wrong type, a missing or misnamed path
  parameter, a body for a route without one, an unknown query key, a field the answer does not
  have; server — the body schema of another route, a missing body or query schema, a body schema
  for a route without a body, another response schema, other query keys, a handler answering the
  wrong type.
- **C1.3, the client over the real transport** (`api-client.spec.ts`, 12 tests): the request it
  makes (method, prefixed path, body, encoded parameters, the query); `signal` reaches `fetch`
  and an abort ends the call; `csrfRecovery: 'public'` and the default `'protected'`; one repeat
  after a token mismatch; an account change is not repeated and reloads; `sessionAfter:
'anonymous'`.
- **C1.7, the bundle.** `check-bundle-graph: 498 modules, no schema and no validator library.`
- `make check`: backend 195 files / 2618 tests, frontend 40 / 467, shared 29, playground 81.
- `pnpm --filter backend test:pg`: 31 files / 288 passed; `test:redis`: 116 passed.
- `pnpm --filter frontend test:e2e`: 88 passed.
- `pnpm --filter frontend test:e2e:live`: 13 passed (the push scenarios of feat-148 now run
  through the contract client) — in 8 of 10 runs; see below.
- ESLint rule: a probe file with `baseApi.http(...)` outside the two files fails with the rule's
  message.
- `pnpm docs:build && pnpm docs:verify`: passed.

### The intermittent 503 of the live e2e

Two of the first five live runs failed in `createVerifiedAccount` (`e2e-live/support.ts`): the
direct API request `POST /api/auth/register/email` answered 503. It is not a call of the new
client. Six runs with `RATE_LIMIT_REDIS_TIMEOUT_MS=1000` had no 503; the default is 50 ms. The
finding and the numbers are in the review report ("found while executing the plan"). Not seen in
CI so far.

### Not verified

- The serialised route list for the API playground was not looked at in the playground itself;
  the serialisation tests pass.
- Multipart routes are outside the pilot by design.

## Notes for Next Session

- C1.R: the owner decides whether C4 (the other groups) starts.
- C4 lowers `DIRECT_HTTP_CALLS` in `api-direct-calls.spec.ts` with every group.
