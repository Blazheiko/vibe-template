# feat-226: Scheduler Docs Gaps

Owner: Blazheiko · Branch: `docs/scheduler-docs-gaps` · Registry PR: #690

## Current state

Done; docs only. Ready for review.

## What was changed (both locales)

1. `backend/scheduler.md`, "Adding a job": batches as
   `= ANY(ARRAY(SELECT id … WHERE <condition> ORDER BY <indexed column> LIMIT n))` with an index on
   the condition's column, instead of `IN (SELECT … LIMIT n)`. Why, with the feat-223 review
   measurement, and links to `expired-rows.ts` and the plan test in `auth-token-cleanup.pg.test.ts`.
2. `backend/deployment.md`: new section "Background jobs": replicas and `SCHEDULER_ENABLED` /
   `SCHEDULER_DISABLED_JOBS`, Redis `maxmemory-policy noeviction` (default in `redis:7`; check
   on a managed Redis), the stop order and `stop_grace_period` ≥ 15 s, `job:run` in the container.
   The graceful-shutdown item now starts with the scheduler stop (`stopHandler` in `index.ts`).
3. `backend/scheduler.md`, "Variables": a table of job variables (`AUTH_TOKEN_RETENTION`).
4. `backend/observability.md`: section "Background jobs": the run log fields, levels, Sentry tags
   `job`/`outcome`, how to find a failing job, link to the outcomes table.

## Checked against the code

- Stop order: `stopHandler` → `scheduler.stop()` (drain `DEFAULT_STOP_DRAIN_MS` = 5 s) →
  `stopServer`; then `drainDisconnects(3000)`, `sentryService.flush(2000)` (`index.ts`). Docker's
  default grace period is 10 s, hence the `stop_grace_period` advice.
- `docker-compose.yml` service `app`; the image copies `packages/backend/dist`, which holds
  `scripts/run-job.js`.

## Evidence of Completion

- `pnpm docs:build && pnpm docs:verify`: `verify-dist: all checks passed` (it caught two wrong
  anchors first, fixed).
- `prettier --check` on `documentation/`: clean.
- No code changed, so no `make check` delta beyond format.

## Noticed, not changed

- `scheduler.ts:48` comment names a variable `SCHEDULER_STOP_DRAIN_MS` that does not exist (the
  drain is fixed at 5 s).
- `backend/testing.md` lists only `PG_TEST_URL` for `*.pg.test.ts`; 8 PG files also need
  `REDIS_TEST_URL` (`pg-tests.yml` sets it).
