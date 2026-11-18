# feat-222: Background Job Scheduler Core

Owner: Blazheiko · Branch: `feat/scheduler-core` · Status PR: #679 (merged)

Plan: `docs/plan/scheduler-plan.md` (Р1–Р13), tasks T1–T12 of `docs/plan/scheduler-tasks.md`.

## Current state

T1–T12 done; ready for `review`. The registry is empty: the first jobs come in feat-223 and
feat-224.

## What was built

- `app/services/shared/checkpoint.ts` (`Checkpoint`, `noCheckpoint`), `purge-counts.ts`.
- `redis-lease.ts`: `HeldLease.abandon()` (renewals and deadline stop, the key stays to its TTL;
  later `release()`/`abandon()` are no-ops), `checkpoint()` (synchronous check against the
  monotonic `lostAt`), `evalAsOwner()` (prepends the owner guard, returns `'not-owner'`).
  A second `release()` no longer reaches Redis.
- `app/scheduler/`: `schedule.ts` (validated `duration()`, `every` grid, `dailyAt`), `job.ts`
  (`defineJob`, outcomes and categories), `job-lease.ts` (`leaseForJob`, `withJobLease`),
  `scheduler-state.ts` (owner-checked Lua writes, backoff), `scheduler.ts` (loop, due check,
  classification, local backoff, `stop()` with drain and `abandon()`, `runOnce`),
  `app-scheduler.ts`, `jobs/index.ts` (empty registry, `SCHEDULER_DISABLED_JOBS` check).
- `config/scheduler.ts`, `validate-runtime-config.ts`, `index.ts` (built before the server, started
  after `initServer`, `await scheduler.stop()` in `stopHandler`), `.env.example`.
- `layering.spec.ts`: `app/scheduler/**` imports no repositories; readiness imports no scheduler.
- `scripts/run-job.ts` (`job:run`), `run-job-args.ts`, `redis-ready.ts`.
- Docs: `documentation/{,en/}backend/scheduler.md`, configuration (both locales), tutorial
  paragraph (both locales), sidebar, `KEY_PAGES`/`EN_KEY_PAGES`, `backend-feature` skill.

## Deviations from the task list

- `HeldLease.evalAsOwner` prepends the owner guard itself instead of asking every script to start
  with it, so a script cannot forget it.
- A failed run whose failure write the owner check refused is reported as `lease-lost` but still
  sent to Sentry (the exception is real); otherwise Sentry gets exactly `failed` and `timeout`.
- The lease TTL of a job is 23.5 s with the default `DB_QUERY_TIMEOUT_MS`, not 15 s:
  `leaseForDatabaseWrites` grows it to `bound + 1 s + 2 × renewEvery` (Р13 says "далі
  `leaseForDatabaseWrites` збільшує їх за потреби").
- `job:run` waits for the Redis connection first (`redis-ready.ts`): the main client has no
  offline queue, and the manual check showed the first command failing while still connecting.

## Review of 0606f9a

Three confirmed defects in `scheduler.ts`, fixed with a test each (all five new tests fail on
`0606f9a` and pass now):

- a `stop()` during the state read, or a `runOnce` signal aborted beforehand, still called
  `job.run()`: `execute()` now calls `scope.checkpoint()` before `run()` (outcome `shutdown`);
- a lease lost during the run set no local backoff: `lease-lost` now holds the job back locally;
- a success seen in Redis did not reset the local failure count: the local backoff now records
  when it was set, and a later success in the state (or a slot already succeeded) clears it.

Also from the review: a `release()` that failed (Redis unavailable) can be tried again; only one
that reached Redis, or `abandon()`, makes later calls no-ops (the knowledge-base fallback relies
on retrying). The wrapper `withJobLease` still calls `fn` when the caller signal is already
aborted: every path runs the job through `execute()`, whose first step is that checkpoint.

## Evidence of Completion

- Baseline `./init.sh` (before any change): green; backend 210 files / 2988 tests, frontend 55 /
  614, landing 103, api-playground 115.
- `make check` after the review fixes: green; backend 220 files / 3119 tests, frontend 55 / 614,
  landing 103, api-playground 115.
- `make test-redis` with `REDIS_TEST_URL=redis://127.0.0.1:6390/15` (throwaway `redis:7-alpine`):
  15 files / 141 tests passed, 0 skipped.
- `make test-pg` with `PG_TEST_URL` (throwaway `pgvector/pgvector:pg16` on 5440) and
  `REDIS_TEST_URL`: 36 files / 333 tests passed, 0 skipped; includes
  `scheduler-shutdown.pg.test.ts` (2 scenarios).
- Mutation check: with `stop()` releasing instead of abandoning, the shutdown PG test fails.
- `pnpm docs:build && pnpm docs:verify`: `verify-dist: all checks passed`.
- Manual golden path (two backend copies on one Redis, `SCHEDULER_TICK=5s`, a temporary
  `every: '1m'` job that was not committed):
    - one run per slot: slots 14:52, 14:53, 14:54 (copy A) and 14:55 (copy B) UTC, each run once,
      the other copy logged `skipped-locked`;
    - SIGTERM during a job longer than the drain (8 s SQL, 5 s drain): `the job did not stop within
the drain; its lease is left to expire` at +5 s, the SQL ended at +6.9 s with
      `outcome: shutdown`, the key lived to its TTL (`PTTL` falling to -2 at about +27 s), the
      other copy logged `skipped-locked` until then and started at +28 s;
    - SIGTERM during a job shorter than the drain: `shutdown`, key removed at once, the other copy
      ran the slot on its next tick;
    - a failing job: both copies kept to one `nextRetryAt` (one `failed` per minute across both,
      `skipped-backoff` otherwise; `consecutiveFailures` 4 after four minutes, backoff capped at
      `every` = 1m);
    - `job:run manual-check` during a scheduled run: `Busy: … try again later.`, exit code 75 from
      the script (`pnpm` reports 1; documented).

## Notes for Next Session

- Local PG/Redis: throwaway containers `vibe-sched-redis` (127.0.0.1:6390) and `vibe-sched-pg`
  (127.0.0.1:5440); the containers on 5432/6379 belong to another project, do not use them.
- After merge: "Mark feat-222 done" PR; then feat-223 (T13).
