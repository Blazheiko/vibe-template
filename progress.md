# feat-169 — Admin Monitoring Routes Contracts (C4.1)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (C7, C4, C8, C5b, C6), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (C4.1). Depends on feat-172.

## State

Done, waiting for review and merge.

## What changed

Five routes on contracts. Each has a contract in `shared/contracts/admin.ts` and an entry in
`app/routes/contract-schemas/admin.ts`, and is declared in `http-routes.ts` by `contract` alone:

| Contract                       | Route                               | Frontend                      |
| ------------------------------ | ----------------------------------- | ----------------------------- |
| `adminContracts.onlineUsers`   | `GET /admin/users-online`           | `adminOnlineUsersApi.list`    |
| `adminContracts.onlineUser`    | `GET /admin/users-online/:id`       | `adminOnlineUsersApi.getById` |
| `adminContracts.onlineHistory` | `GET /admin/history-online` (query) | `adminOnlineHistoryApi.list`  |
| `adminContracts.textUsage`     | `GET /admin/usage/text` (query)     | no caller                     |
| `adminContracts.usageStats`    | `GET /admin/usage/stats`            | no caller                     |

- Three frontend calls now use `callApi`; `DIRECT_HTTP_CALLS` is 36 → 33. The hand-written URL
  building and `encodeURIComponent` of these calls went away: `buildUrl` of the contract does it.
- `admin-query.spec.ts` compares the method and the URL the transport gets, as in the pilot (the
  typed client also passes an empty body and no options).
- Docs (both locales): `backend/routing.md`, the list of routes on contracts.

## Evidence of Completion

- `make check`: backend 2656, frontend 499, shared 30, playground 111 (bundle graph: no schema).
- `pnpm --filter backend test:pg` (with `REDIS_TEST_URL`): 295 passed.
- `pnpm --filter frontend test:e2e`: 92 passed (the admin pages included).
- `pnpm docs:build && pnpm docs:verify`: passed.
- The requests are the same as before: `admin-query.spec.ts` checks the exact URLs, encoding and
  the order of the query keys included.

### Not verified

- `/admin/usage/*` has no frontend caller; only its backend side and its types are checked.
