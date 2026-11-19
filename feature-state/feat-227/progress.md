# feat-227: Scheduled Job Skill

Owner: Blazheiko · Branch: `docs/scheduled-job-skill` · Registry PR: #693

## Current state

Done; docs, skill and AGENTS.md only. Ready for review.

## What was changed

1. `documentation/{,en/}backend/scheduler.md`, "Adding a job": steps 3–5 added.
    - 3, job variables: own `config/<job>.ts` with `configError` in `validate-runtime-config.ts`
      and `.env.example`; why not a widely imported config (the `metautil` mocks, 394 tests in
      feat-223); the job refuses to run on its config error because `job:run` skips the startup
      check.
    - 4, tests: the job's unit test, and the PG test list (cut-off to the minute on either side,
      batch loop, throwing checkpoint, dry run, overlap with `race-barrier.ts`, plan with
      `enable_seqscan`/`enable_sort` off); the earlier one-line test bullet and the plan-test
      sentence of the batch bullet moved here, so each rule has one home.
    - 5, docs and the manual `job:run --dry-run` check.
2. `.claude/skills/scheduled-job/SKILL.md`: model-invoked; points at "Adding a job" as the source
   of truth and `auth-token-cleanup` as the living model; seven steps, each with a completion
   check (the tests step asks for a mutation per guarded line).
3. `AGENTS.md` → Agent Skills: `scheduled-job` and its source of truth; a change to the scheduler
   contract (`defineJob`, `JobContext`, `withJobLease`, Р13) updates the page (both locales) and
   the skill in the same PR.

## Evidence of Completion

- `pnpm docs:build && pnpm docs:verify`: `verify-dist: all checks passed`.
- `pnpm format:check`: clean.
- The skill is picked up by Claude Code from `.claude/skills/` (listed in the session after it
  was written). Its first real use is feat-224.
