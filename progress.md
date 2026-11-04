# feat-113 — Infra Config Guards

Plan: `docs/plan/code-review-2026-11-03-plan.md`, item R10 (findings 20, 21). Branch: `fix/feat-113-infra-config-guards` (from `main` after #371).

## Current State

Implemented; PR open.

- Main pg pool (`database/db.ts`): `statement_timeout` = `DB_QUERY_TIMEOUT_MS` (default 10000, 100–600000), `query_timeout` 500 ms later. A hung statement is cancelled (57014) instead of holding its connection. The setting lives in the new `config/database-pool.ts` (an env-reader config error, checked by `validateRuntimeConfig` as `database`), because `config/database.ts` is loaded by drizzle-kit.
- `GET /ready` (`database/readiness-probe.ts`, used by `healthRepository.pingDatabase`):
    - its own `pg.Pool` with `max: 1` and `application_name=readiness-probe`, not the main pool and not the session-check pool;
    - `connectionTimeoutMillis`, `statement_timeout` and `query_timeout` all equal `READINESS_CHECK_TIMEOUT_MS`;
    - one probe in flight: the next ping rejects at once with `ProbeInFlightError` ("not ready") until the previous one settles;
    - closed on shutdown in `index.ts`.
    - Recorded answer for a saturated main pool: `200` within the deadline.
- `config/sentry.ts`: `parseTraceSampleRate` returns `{ value, error }`. A non-decimal or out-of-range `SENTRY_TRACES_SAMPLE_RATE` becomes `configError`, so startup stops (it used to warn and fall back to 0).
- Docs: `configuration.md` (new `DB_QUERY_TIMEOUT_MS`, `READINESS_CHECK_TIMEOUT_MS`, `SENTRY_TRACES_SAMPLE_RATE`), `observability.md` (`/ready`), `database.md` (query timeout), `auth.md` (why the session-check pool is separate); `.env.example`.

## Files Modified

- `packages/backend/src/database/db.ts`, `src/index.ts`, `src/app/repositories/health/health-repository.ts`
- `packages/backend/src/config/sentry.ts`, `src/app/start/validate-runtime-config.ts` + spec
- New: `src/config/database-pool.ts` + spec, `src/config/sentry.spec.ts`, `src/database/readiness-probe.ts`, `src/database/readiness-probe.pg.test.ts`
- `packages/backend/.env.example`, docs as above.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 2333, frontend 400, api-playground 62, shared 25, documentation 26 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` with Redis: 25 files / 223 passed. `test:redis`: 10 files / 102 passed.
- `readiness-probe.pg.test.ts` (real PostgreSQL):
    - all 10 main-pool connections in `pg_sleep(1)` → `readinessService.check()` is ready in < 500 ms;
    - probe statement `pg_sleep(5)`, deadline 300 ms → 5 parallel pings reject with `ProbeInFlightError`, one connection in `pg_stat_activity`, the first rejects in < 1 s, nothing stays active (server cancelled);
    - recovery on the same probe: once the statement answers, the next ping resolves;
    - a TCP server that accepts and never answers → two pings in a row reject within the deadline (not stuck "in progress");
    - main pool with `DB_QUERY_TIMEOUT_MS=1500`: `pg_sleep(5)` rejects with 57014 and the pool still answers `SELECT 1`.
- Mutation check:
    - with `main`'s `health-repository.ts`, `db.ts` and `sentry.ts`, the saturated-pool and main-pool-timeout PG cases fail, and the sentry and validator specs fail;
    - without the in-flight guard, the parallel-probe case fails.
- Manual (built backend):
    - `SENTRY_TRACES_SAMPLE_RATE=abc` → exit 1, `Invalid Sentry configuration: SENTRY_TRACES_SAMPLE_RATE must be a number from 0 to 1`;
    - `DB_QUERY_TIMEOUT_MS=50` → exit 1, `Invalid database configuration: DB_QUERY_TIMEOUT_MS must be an integer from 100 to 600000`;
    - normal start: `/api/ready` returns `200 {"status":"ok"}` three times (2–21 ms), `pg_stat_activity` shows one `readiness-probe` connection, and SIGTERM exits 0.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next by the plan order (wave 4): R11b (KB `content_version`, migration).
