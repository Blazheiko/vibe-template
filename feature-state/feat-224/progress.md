# feat-224: LLM Prompt Retention Job

Owner: Blazheiko · Branch: `feat/llm-prompt-retention-job` · Status PR: #704

Plan: `docs/plan/scheduler-plan.md` (feat-224), tasks T19–T23 of `docs/plan/scheduler-tasks.md`;
built with the `scheduled-job` skill (feat-227).

## Current state

T19–T23 done. Next: implementation PR, `review`.

## Decision: batches from a partial index (measured before coding)

The purge of feat-130 paged the whole table by `id` on every run. As a daily job that is a full
walk every day, growing with the history. Measured on the real schema (300k rows over 365 days,
the last 31 days with text, 822 rows past the 30-day retention):

| Variant                                                  | Per run                                                | Time                                              |
| -------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| A. id paging (feat-130)                                  | 300 pages, 600 statements                              | 79 ms in the database alone, plus 600 round trips |
| C. existing `created_at` index                           | filters 274 521 purged rows per batch, forever growing | 30 ms per batch                                   |
| B. partial index `(created_at) WHERE final_prompt <> ''` | reads the 822 due rows                                 | 0.24 ms per batch; dry run 0.1 ms                 |

B is taken: migration `20261119121045_llm_usage_prompt_text_idx`; a batch is
`UPDATE … WHERE id = ANY(ARRAY(SELECT id … WHERE final_prompt <> '' [AND created_at <= $1]
ORDER BY created_at LIMIT n)) AND final_prompt <> '' RETURNING id`. The repeated outer condition
keeps two overlapping runs from counting a row twice. The dry run is one `count(*)` over the same
index (it touches only rows that still hold text).

## What was built

- `llm-usage-repository.ts`: `purgePromptText({ olderThan, dryRun, batchSize, checkpoint })` →
  `PurgeCounts`, `checkpoint()` right before every statement; `promptPurgeBatch` exported for the
  plan test. `llm-usage-service.ts` passes `checkpoint`.
- `planPurge`/`purgeConfigError` moved from `scripts/purge-llm-prompts-args.ts` to
  `app/services/ai/usage/prompt-purge-plan.ts` (with its spec), so the job does not import
  `scripts/`.
- `app/scheduler/jobs/llm-prompt-retention.ts`: `{ dailyAt: '04:00' }`, `timeout: '10m'`, plan
  from `planPurge([], usage, now)`, refuses on `aiConfig.configError`; in the registry.
- `scripts/purge-llm-prompts-cli.ts` (`runPromptPurge`) + `purge-llm-prompts.ts`: the CLI keeps
  `--all`/`--days`/`--dry-run`, takes the job's lease through `withJobLease` with a SIGINT/SIGTERM
  signal, waits for Redis; busy → 75, interrupted → 130, error → 1; schedule state untouched.
- Docs (both locales): `ai.md` (the batch, the daily job, the CLI and Redis; the cron advice
  removed), `scheduler.md` (jobs table, job variables, the plan warning removed),
  `configuration.md`, `database.md` (migration).

## Deviations from the task list

- T20 named `usage-audit.pg.test.ts` or a new file; the existing
  `llm-prompt-retention.pg.test.ts` was extended instead. Its feat-130 test "pages the table by
  id" is replaced by the plan test, since the paging it pinned is what changed.
- The batch design (partial index) is new against T20, as decided above.
- No new env variable: the job reads the existing `AI_USAGE_*` from `config/ai.ts`.

## Evidence of Completion

- Baseline `./init.sh` (main at the start): green; backend 222 files / 3135 tests, frontend
  55 / 614, landing 103, api-playground 115.
- `make check`: green; backend 223 files / 3141 tests, frontend 55 / 614, landing 103,
  api-playground 115.
- `make test-pg` (throwaway PG on 5440, `REDIS_TEST_URL` on 6390): 37 files / 344 tests passed,
  0 skipped. `llm-prompt-retention.pg.test.ts` 16: plan from the partial index without a sort
  (with and without a cut-off), the cut-off to the minute (before/at purged, after kept), a
  throwing checkpoint stops after the first batch, two overlapping runs (race barrier) empty each
  row once, dry run counts all rows with text and changes nothing, plus the feat-065 tests.
- `make test-redis`: 16 files / 147 tests passed, 0 skipped. New
  `purge-llm-prompts-cli.redis.test.ts` (4): purges under the lease and frees it, state key
  untouched; busy → 75 without purging; an error frees the lease; interrupted → 130.
- Unit: `llm-prompt-retention.spec.ts` (schedule, both plans, dry run, refusal on config error);
  `jobs/index.spec.ts` covers the Р13 bound for both jobs.
- Mutations (each fails the test that guards it): no `checkpoint()` before a batch → the
  checkpoint test; `lte` → `lt` → the cut-off test; `ORDER BY id` → both plan tests; no outer
  `final_prompt <> ''` → the overlap test.
- `pnpm docs:build && pnpm docs:verify`: `verify-dist: all checks passed`.
- Manual golden path (`feat224_manual` on the throwaway PG, Redis 6390, `STORE_PROMPTS=true`,
  retention 30): rows aged 90 (no text), 60, 45, 31, 29, 5. `job:run llm-prompt-retention
--dry-run`: matched 3; `llm:purge-prompts --dry-run`: 3 rows — the same; the CLI with the job
  lease held: `Busy…`, exit 75; `job:run` real: matched 3, changed 3; the 60/45/31 rows empty
  and hashed, 29 and 5 keep their text; the CLI after that: 0 rows.

## Notes for Next Session

- Local PG/Redis: throwaway `vibe-sched-pg` (5440), `vibe-sched-redis` (6390); the containers on
  5432/6379 belong to another project.
- After merge: "Mark feat-224 done".
