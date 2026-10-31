# Session Progress Log

## Current State

**Last Updated:** 2026-10-31
**Active Feature:** feat-052 - Node 24.22.2 + uWebSockets.js v20.71.0
**Branch:** `chore/node-24.22.2-uws-20.71` (status PR #169: plan + feat-052 → `in_progress`)
**Plan:** `docs/plan/node-24.22.2-uws-20.71-upgrade-plan.md` (PR 1 = stages A, B)

## Status

### Done

- [x] B.0 baseline on `main` (uWS v20.56.0, Node v24.22.2) — tests and transport benchmark below
- [x] B.1 release notes v20.57–v20.71 and `index.d.ts` diff: API changes are additive only (`onDataV2`, `collectBody`, `beginWrite`, `getRemotePort`, `getProxiedRemotePort`, WS `send*Fragment`, `getDescriptor`, wider `RecognizedString`). Relevant: v20.57 `getParts` returns copies (we use it in `http-request-handlers.ts:175`, read-only — safe), v20.64 upstream backpressure fix, v20.67 drops Node 20/25 and adds 26, v20.70 HTTP compliance. Prebuilt ABI 137 (Node 24): darwin-arm64, linux-x64, linux-arm64
- [x] B.2 `uWebSockets.js#v20.71.0`. **Upstream bug:** `ESM_wrapper.mjs` imports the missing `./index.js` ([uWS#1356](https://github.com/uNetworking/uWebSockets.js/issues/1356), fixed on master, not released) — 24 backend tests failed and the server did not start. Fixed by `patches/uWebSockets.js@20.71.0.patch` (one line, `./uws.js`) via `pnpm.patchedDependencies` (owner's choice). `pnpm patch-commit` fails for git dependencies in pnpm 9 (looks the package up in the npm registry), so the patch file is hand-written. Dockerfile copies `patches/` before both `pnpm install`. Integration points (`server.ts`, `static-server.ts`, `ws-handlers.ts`, `http-request-handlers.ts`, `header-checker.ts`, `types.d.ts`) needed no changes; no test expectation changed
- [x] A: `.nvmrc` 24.22.2, `engines ^24.22.2` (root, api-playground), Dockerfile `ARG NODE_VERSION=24.22.2` → `nodejs=${NODE_VERSION}-1nodesource1` + `node -v` assert in both stages, docs (`AGENTS.md`, `README.md`, guide, `toolchain.md` incl. the uWS patch section, `backend/index.md`, requirements)
- [x] B.4 backpressure (runtime, new addon): see Evidence
- [x] B.3 `docker buildx build --platform linux/amd64`: exit 0; `nodejs=24.22.2-1nodesource1` exists, both stages assert `node -v`; in the container `node -v` → `v24.22.2`, `import('uWebSockets.js')` → `App` is a function on `x64`, patched `ESM_wrapper.mjs` imports `./uws.js`
- [x] B.5 `test:e2e:security` against the built prod server: 7 passed. Port 3000 is taken by unrelated local `promo-designer` processes (not touched), so the run used `PORT=3200` with `e2e-security/fixtures.ts` `PORT` temporarily set to 3200 and restored (`git diff` empty)
- [x] B.5 manual on the bench server (v20.71): JSON body 2 097 141 B → 422 (read fully, validation), 3 000 009 B → 413 with Content-Length and chunked; 5 aborted slow downloads of the 8 MB file → server alive, no ERROR in the log, next full download 200 / 8 388 608 B / sha256 match. WS connect / subscribe / broadcast / close — the WS benchmark (500 + 20 connections, 10 000/10 000 delivered). Note: `prod-local.sh --build-only` rebuilds `packages/backend/public/`, which deletes the bench file — recreate it after e2e
- [x] `CI=1 pnpm --filter frontend test:e2e`: 12 passed

### In progress / remaining

- [ ] B.4 performance rerun: both the baseline and the v20.71 runs were on battery, and two v20.71 wrk runs crossed a lid-close sleep (`pmset` log: Clamshell Sleep 11:51–12:08, the 16.7-min run) — invalid. Needs AC power + lid open, baseline and new version back to back

## Benchmark setup (B.4)

Scratchpad scripts (not in the repo): `bench.env`, `run-http-bench.sh`, `run-ws-bench.sh`, `wsbench/ws-bench.mjs`, `run-backpressure.sh`, `restart.sh`.

`bench.env`:

```
APP_ENV=development        # not manual-test: static is served from public/
NODE_ENV=production
PORT=3100
SERVE_STATIC=true
STATIC_MAX_MEMORY_FILE_SIZE=1048576
HTTP_GLOBAL_RATE_LIMIT_MAX=100000000
WS_UPGRADE_RATE_LIMIT_MAX=100000000
WS_UPGRADE_SHARED_RATE_LIMIT_MAX=0
LOG_LEVEL=warn
PGSQL_DB_NAME=itvibe_bench
TRUST_PROXY=true
TRUSTED_PROXY_CIDRS=127.0.0.1/32
```

Deviations from the plan, found while running it:

- The local dev DB `itvibe_template` is behind the migrations (`user_online.role` missing, `db:migrate` fails on an existing `chat_role` type) — left untouched. The benchmark uses a fresh `itvibe_bench` (pgvector, all migrations, `db:seed --demo`, 20 extra `bench*` users, ids 3–22)
- No public API GET route without auth or a hard-coded group limit: the API row measures `GET /api/main/init` unauthenticated (full middleware pipeline, always 401); validity = every response 401, no socket errors
- WS route limits are hard-coded per client IP (`ws-routes.ts:26`, 120/min for admin): each benchmark connection sends its own `X-Forwarded-For` (TRUST_PROXY for 127.0.0.1)
- WS sessions/tokens are written to Redis by the script (WS tokens are single-use); the admin role loads asynchronously after open, so subscribe is retried on 403
- WS scenario: 500 admin connections subscribe to `api/admin/subscribe_online_users`, 20 distinct users connect at once → 10 000 `broadcast:admin_user_online_upsert` expected

## Evidence of Completion

| Check                                                           | Baseline (v20.56.0)                                      | v20.71.0                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check`                      | exit 0                                                   | exit 0                                                   |
| `pnpm test` backend / frontend / api-playground / shared / docs | 1174 / 168 / 14 / 14 / 26, 0 skipped                     | 1174 / 168 / 14 / 14 / 26, 0 skipped                     |
| `test:redis` (`REDIS_TEST_URL=redis://127.0.0.1:6379/15`)       | 45 passed                                                | 45 passed                                                |
| `test:pg` (`PG_TEST_URL=…/postgres`)                            | 23 passed                                                | 23 passed                                                |
| `docs:build && docs:verify`                                     | —                                                        | passed                                                   |
| Backpressure, `curl --limit-rate 100k`, 8 MB                    | onWritable 22, sha256 match, 8388608 B, RSS 64 MB during | onWritable 30, sha256 match, 8388608 B, RSS 49 MB during |
| WS 500×20 (3 runs)                                              | 500/500 handshake, 500 subscribed, 10000/10000 delivered | same, all three runs                                     |

Performance (median of 3, **provisional — battery, see In progress**):

| Row                              | Baseline                | v20.71.0                                            |
| -------------------------------- | ----------------------- | --------------------------------------------------- |
| static `/robots.txt` (RAM), c100 | 89 800 rps, p99 2.21 ms | 89 244 rps, p99 2.53 ms                             |
| `/api/main/init` 401, c100       | 17 081 rps, p99 49.8 ms | 17 988 rps, p99 69.2 ms                             |
| stream 8 MB (disk), c50          | 1 331 MB/s, p99 456 ms  | runs 1–2: 1 362 / 1 464 MB/s; run 3 invalid (sleep) |
| WS handshake 500                 | 160 ms                  | 160–714 ms                                          |
| WS broadcast 10 000              | 51 ms                   | 135–437 ms                                          |

## Notes for Next Session

1. Plug in power, keep the lid open, `caffeinate -i`; rerun baseline (checkout `main`'s uWS) and v20.71 back to back
2. Then B.3 Docker, B.5, e2e; commit; PR
