# Session Progress Log

## Current State

**Last Updated:** 2026-10-31
**Active Feature:** feat-058 - Push Subscription IDOR
**Branch:** `fix/push-subscription-idor`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase A (source: `docs/security/code-review-main-2026-10-31.md`, finding 1)

## Status

### Done

- [x] Diagnosis: `pushSubscriptionRepository.update()` and `deactivate()` ran an owner-scoped `UPDATE … WHERE id AND user_id`, then returned `findById(id)` with no owner filter. A foreign id matched 0 rows but the service saw a defined row and answered `200` with the serialized subscription (endpoint, push keys, IP, user agent, device data). `GET /:id`, `DELETE`, logs and statistics were already scoped
- [x] Inventory: no other repository re-reads by id after a user-scoped mutation (`user-repository.ts` `update(id)` is unscoped by design)
- [x] Test first (`push-subscription-ownership.pg.test.ts`, real controller + service + repository on PostgreSQL): 3 of 7 failed with `expected 200 to be 404` before the fix
- [x] Fix: `update()` and `deactivate()` return the row of the owner-scoped `UPDATE … RETURNING`; `updateByEndpoint` untouched (moving a subscription to another account after the browser-key check is intentional) and now carries a comment saying so
- [x] Docs: `documentation/backend/web-push-notification.md` — ownership paragraph under the route table

- [x] Review follow-ups (4 findings): (1) the ownership test went through a hand-built context, bypassing routing, body validation and `auth_guard` — it now goes over real HTTP (uWebSockets.js server, real route table, real `auth_guard`; `session_web` only maps an `x-test-user` header to the user and `csrf_guard` is a pass-through, both covered by their own Redis tests); 14 tests, 3 fail on the pre-fix repository with `expected 200 to be 404`; works without Redis (the CI `test-pg` job has none). (2) docs: `GET /:id/logs` answers `200` with an empty list for a foreign id (it does not look the subscription up) — the 404 claim is now limited to the routes that do. (3) `feature_list.json`: feat-070 now depends on feat-077 (K1), feat-075 on feat-078/079 (K2/K3), feat-076 on feat-069 — the full registry was audited against the plan. (4) plan: one id system (`feat-NNN`), headings and summary table checked against the mapping table and the registry

### Behaviour change to know

`PUT /push-subscriptions/:id` and `PUT /push-subscriptions/:id/deactivate` answer `404 Subscription not found` for a foreign id (was `200` with the other user's record). A foreign and a missing id give the identical response body.

## Evidence of Completion

| Check                                                     | Result                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| New test before the fix                                   | 3 failed / 4 passed (foreign `PUT` and `deactivate` answered `200`; own update, own deactivate, key-matched move, `409` all green) |
| `pnpm typecheck` / `lint` / `format:check`                | exit 0                                                                                                                             |
| `pnpm test`                                               | backend 1177, frontend 168, api-playground 14, shared 14, docs 26; exit 0                                                          |
| `test:pg` (`PG_TEST_URL`, local PostgreSQL 17 + pgvector) | 37 passed in 5 files (14 new, over real HTTP; also green with Redis unreachable)                                                   |
| `test:redis` (`REDIS_TEST_URL=redis://127.0.0.1:6379/15`) | 61 passed                                                                                                                          |
| `docs:build && docs:verify`                               | passed                                                                                                                             |
| Frontend e2e                                              | not run: backend-only change, no UI touched                                                                                        |

## Notes for Next Session

1. Open the docs PR (`docs/code-review-2026-10-31`: review, plan, ADR 0002, feat-058…083 rows with feat-058 `in_progress`), then this feature PR, then a PR flipping feat-058 to `done`
2. Next feature: feat-059 (Session Revocation) — start from ADR 0002, which needs to be accepted first
