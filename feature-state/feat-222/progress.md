# feat-222: Background Job Scheduler Core

Owner: Blazheiko · Branch: `feat/scheduler-core` · Status PR: #679 (merged)

Plan: `docs/plan/scheduler-plan.md` (Р1–Р13), tasks T1–T12 of `docs/plan/scheduler-tasks.md`.

## Current state

- T1 done: status PR #679 merged; baseline `./init.sh` green on `5c2e040`'s parent (backend 210
  files / 2988 tests, frontend 55 / 614, landing 103, api-playground 115).
- T2–T9 done: `checkpoint.ts`, `purge-counts.ts`, `schedule.ts`, lease `abandon()` /
  `checkpoint()` / `evalAsOwner()`, `job-lease.ts`, `job.ts`, `scheduler-state.ts`,
  `scheduler.ts`, `config/scheduler.ts`, registry, wiring in `index.ts`, layering rules,
  `job:run`.
- In progress: T10 (Redis tests of the core), T11 (PG + Redis shutdown test), T12 (docs).

## Files modified

- packages/backend/src/app/services/shared/{checkpoint,purge-counts}.ts
- packages/backend/src/app/services/shared/redis-lease.ts (+ spec, + redis test)
- packages/backend/src/app/scheduler/** (schedule, job, job-lease, scheduler-state, scheduler,
  app-scheduler, jobs/index + specs and redis tests)
- packages/backend/src/config/scheduler.ts (+ spec), app/start/validate-runtime-config.ts
- packages/backend/src/index.ts, app/layering.spec.ts, .env.example, package.json
- packages/backend/src/scripts/run-job.ts, run-job-args.ts (+ spec), scripts/README.md

## Notes for Next Session

- Local PG/Redis: throwaway containers on 127.0.0.1:6390 (Redis) and :5440 (pgvector), started
  for this feature; the containers on 5432/6379 belong to another project, do not use them.
