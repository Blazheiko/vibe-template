---
name: scheduled-job
description: >
    Adds a background job to the backend scheduler (app/scheduler): a clean-up, retention or other
    periodic work run by defineJob on a schedule. Use it when the user wants something to run on a
    schedule, every N minutes or daily, a periodic purge or retention, a cron-like task, or a new
    entry in app/scheduler/jobs.
---

# Scheduled job

The source of truth is "Adding a job" in `documentation/en/backend/scheduler.md` (UA twin:
`documentation/backend/scheduler.md`), with the guarantees and their limits on the same page.
**Read that page first.** If it and this checklist disagree, the page and the code win: tell the
user the skill is stale. The living model is `auth-token-cleanup` (feat-223): every file named
below has its counterpart there.

## Step 0: Process (AGENTS.md)

The job needs its own `feat-XXX` row in `feature_list.json` (PR to `main`), branch and
`feature-state/<feat-id>/progress.md`. A new env variable or migration is public backend
behaviour: the pages in `documentation/backend/` and `documentation/en/backend/` change in the
same PR.

## Steps

Each step is done when its check holds.

1. **Service method.** In `app/services/<domain>/<job>-service.ts`, it takes the cut-off or plan,
   `dryRun` and `checkpoint`, and returns `PurgeCounts`; it calls `checkpoint()` immediately before every query
   and loops until a batch comes back short. Done: the service imports no `app/scheduler`, and
   no query runs without a `checkpoint()` right before it.
2. **Repository batch.** The batch statement is
   `= ANY(ARRAY(SELECT id … WHERE <condition> ORDER BY <indexed column> LIMIT n))`, and the
   condition's column has an index (a migration if it is missing). Model: `expired-rows.ts`.
   Done: `ORDER BY` names the indexed column, and the index exists in `database/schema.ts`.
3. **Config.** Job variables live in `config/<job>.ts` with a `configError`, registered in
   `app/start/validate-runtime-config.ts`, and in `packages/backend/.env.example`. Done: no
   widely imported config module (`config/auth.ts` and the like) gained an import, and the job's
   `run` throws on `configError` before any work.
4. **Job.** `app/scheduler/jobs/<name>.ts` through `defineJob` (kebab-case name, schedule,
   timeout), wired into `jobs/index.ts`. Done: the job is in the registry and its `run` passes
   `ctx.checkpoint` and `ctx.dryRun` to the service.
5. **Tests**, every one listed under "Tests" in "Adding a job": the job's unit test, and the PG
   test of the service (cut-off on either side to the minute, batch loop, throwing `checkpoint`,
   dry run, two overlapping runs with `race-barrier.ts`, plan with `enable_seqscan` and
   `enable_sort` off). Done: each item has a test, and each test goes red on a mutation of the
   line it guards (remove the `checkpoint()`, `<` to `<=`, `ORDER BY id`); record the mutations
   in `progress.md`.
6. **Docs**, both locales: the Jobs table and Variables on the scheduler page, `configuration.md`,
   the domain page. Done: `pnpm docs:build && pnpm docs:verify` passes.
7. **Verify.** `make check`; `make test-pg` with both `PG_TEST_URL` and `REDIS_TEST_URL` set,
   recording executed and skipped counts; `job:run <name> --dry-run` on seeded rows, then without
   `--dry-run`. Done: the dry-run `matched` equals the real `changed`, and both are in
   `progress.md` under Evidence of Completion.
