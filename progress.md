# Session Progress Log

## Current State

**Last Updated:** 2026-10-31
**Active Feature:** feat-054 - Drizzle 1.0.0-rc.5
**Branch:** `chore/drizzle-rc5` (status PR #175: feat-054 → `in_progress`)
**Plan:** `docs/plan/node-24.22.2-uws-20.71-upgrade-plan.md`, PR 4 (D.2)

## rc.5 breaking changes vs the code

Release notes: https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.5. We use `pg` (`node-postgres`), the core query builder and `defineRelations`; there is **no** `db.query.*` (RQBv2) call in `src/` outside tests.

| Breaking change                                                                                                                                                                             | Affects us                                                                                          | Action                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `db.execute` types reworked (plain call returns a union of driver responses)                                                                                                                | yes: `support-knowledge-repository.ts` `searchByEmbedding`, `harness.pg.test.ts` read `result.rows` | typed form `db.execute<Row>(sql)`; the `as` cast is gone                                                                          |
| drizzle-kit incremental snapshots (version 9)                                                                                                                                               | yes: `generate` refused the old `snapshot.json`                                                     | `drizzle-kit up`: first snapshot keeps `ddl`, later ones `deltas`; `migration.sql` untouched; `db:generate` → «No schema changes» |
| `DrizzleQueryError` omits query `params` by default (`paramsInErrors`)                                                                                                                      | logs only: a failed query is logged without its params                                              | kept the default (no values in logs)                                                                                              |
| RQBv2: `undefined` in `where` throws, empty relation filters skipped, new build strategy, raw refs to relations in `RAW`/`orderBy`, caching with `all` strategy, `DBQueryConfigWithComment` | no — no RQBv2 queries                                                                               | —                                                                                                                                 |
| `postgres-js` parsers, `bytea` codecs, `View`/`getTableUniqueName`/`StringChunk` moves, `withReplicas`, `getSQL()` cast codecs, sqlite/mysql/mssql/cockroach changes                        | no — not used                                                                                       | —                                                                                                                                 |

## Status

### Done

- [x] `drizzle-orm` and `drizzle-kit` `1.0.0-rc.5` (exact, together)
- [x] Typed `db.execute`, snapshots converted, docs: `AGENTS.md`, `toolchain.md`, guide, `backend/index.md`, `backend/database.md` (incremental snapshots, `drizzle-kit up`)
- [x] Fresh DB `itvibe_rc5` (dropped after): `db:create` (+ vector) → `db:migrate` (3 migrations) → `db:seed --demo` (admin 1, user 2); server on it: 5 admin WS connections + 1 user → `user_online` rows inserted/updated through Drizzle (6 rows, all closed, roles stored), role lookup, broadcast 5/5, `/api/ready` 200, no ERROR in the log; `test:e2e:security` against `PGSQL_DB_NAME=itvibe_rc5` (port 3200, fixture restored) — 7 passed

### Notes

- `csrf-bootstrap.redis.test.ts` is flaky on this machine (`Connection is closed`): 1 of 5 runs fails on `main` with rc.4 too, so it is not caused by this upgrade. Same main-Redis-client timeout seen under the feat-052 benchmark

## Evidence of Completion

| Check                                                     | Result                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check` / `build`      | exit 0                                                            |
| `pnpm test`                                               | backend 1174, frontend 168, api-playground 14, shared 14, docs 26 |
| `test:pg` (`PG_TEST_URL=…/postgres`)                      | 23 passed                                                         |
| `test:redis` (`REDIS_TEST_URL=redis://127.0.0.1:6379/15`) | 45 passed (a rerun; flaky test above)                             |
| `db:generate`                                             | no new migration                                                  |
| `CI=1 pnpm --filter frontend test:e2e`                    | 12 passed                                                         |
| `test:e2e:security` on the fresh DB                       | 7 passed                                                          |
| `pnpm docs:build && pnpm docs:verify`                     | passed                                                            |

## Notes for Next Session

1. Merge status PR #175 and the feature PR, then the done-PR
2. Next in the plan: PR 3 (`@mistralai/mistralai` 3.x), PR 5 (Mermaid 12)
