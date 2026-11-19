# feat-224: LLM Prompt Retention Job

Owner: Blazheiko · Branch: `feat/llm-prompt-retention-job` · Status PR: #704

Plan: `docs/plan/scheduler-plan.md` (feat-224), tasks T19–T23 of `docs/plan/scheduler-tasks.md`;
built with the `scheduled-job` skill (feat-227).

## Current state

T19–T23 done; implementation PR #705, status `review` (#706). An independent review found
two risks that contradicted claims of this file; both are fixed below. Next: merge #705, then
"Mark feat-224 done".

## Decision: batches from a partial index (measured before coding)

The purge of feat-130 paged the whole table by `id` on every run. As a daily job that is a full
walk every day, growing with the history. Measured on the real schema (300k rows over 365 days,
the last 31 days with text, 822 rows past the 30-day retention):

| Variant                                                  | Per run                                                | Time                                              |
| -------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| A. id paging (feat-130)                                  | 300 pages, 600 statements                              | 79 ms in the database alone, plus 600 round trips |
| C. existing `created_at` index                           | filters 274 521 purged rows per batch, forever growing | 30 ms per batch                                   |
| B. partial index `(created_at) WHERE final_prompt <> ''` | reads the 822 due rows                                 | 0.24 ms per batch; dry run 0.1 ms                 |

B was taken; the review then showed that "a purged row leaves the index" and a one-statement dry
run do not hold in general (see the review section). Final design: migration
`20261119123718_llm_usage_prompt_text_idx`, partial index on `(created_at, id)`; every batch,
purge or dry-run count, walks it with a keyset cursor `(created_at, id) > (last of the previous
batch)`; the UPDATE repeats `final_prompt <> ''`, so two overlapping runs do not count a row
twice. The cursor travels as the database's text (microseconds; a JS Date would drop them).

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

## Independent review of #705

No bug in which rows are emptied or kept. Findings and what was done:

1. **Risk, fixed.** The dry run was one `count(*)` again, the timeout feat-130 had fixed: on a
   legacy table where every row holds text the planner took a seq scan (3M rows: 1.6–2.2 s,
   about 15M rows to the 10 s `statement_timeout`). Now the dry run counts in keyset batches.
   Measured on 1M rows all with text: 1001 statements, 1.4 s, 1.1 ms per statement (max 28 ms,
   the first).
2. **Risk, fixed.** "A purged row leaves the index" holds only once its dead entry is cleaned up;
   with a long snapshot open elsewhere every batch rescanned the entries earlier batches emptied
   (22 → 92 → 233 ms per batch). With the keyset cursor a batch starts after the previous one.
   Measured: 920k rows purged with a REPEATABLE READ transaction open the whole time: 918
   statements, 18.5 s, flat about 13 ms per batch (the first 0.96 s, JIT). Remaining limit,
   documented: while such a snapshot is open, the first batch of each run walks the dead entries
   once (2.1 s for 917k); after it ends and VACUUM runs, the first batch is 0.16 ms.
3. **Documented.** The CLI now runs within the job's 10-minute timeout; a longer purge exits 1 and
   a rerun continues.
4. **Documented; the migration is `CREATE INDEX IF NOT EXISTS`.** No `CONCURRENTLY` (writes wait
   while it builds, about 10 s on 3M rows); on a large existing table create it beforehand with
   `CONCURRENTLY` under the same name. Checked: with the index already there, `drizzle-kit
migrate` applies the migration.
5. Overlap: confirmed correct by the reviewer (the loser stops early; each row once).
6. **Added.** A PG test of the job itself on the real table with the real service (T21).
7. **Fixed.** The CLI's "stopped" line now prints `changed` too.

On a large analysed table with text everywhere the planner may take the plain `created_at` index
for a batch after a cursor (about 1 ms per batch there); once the history is purged it takes the
partial index (0.16 ms). The plan test switches seq scan and (incremental) sort off on its small
tables.

## Deviations from the task list

- T20 named `usage-audit.pg.test.ts` or a new file; the existing
  `llm-prompt-retention.pg.test.ts` was extended instead. Its feat-130 test "pages the table by
  id" is replaced by the plan test, since the paging it pinned is what changed.
- The batch design (partial index) is new against T20, as decided above.
- No new env variable: the job reads the existing `AI_USAGE_*` from `config/ai.ts`.

## Evidence of Completion

- Baseline `./init.sh` (main at the start): green; backend 222 files / 3135 tests, frontend
  55 / 614, landing 103, api-playground 115.
- `make check` (after the review fixes): green; backend 223 files / 3141 tests, frontend 55 / 614, landing 103,
  api-playground 115.
- `make test-pg` (throwaway PG on 5440, `REDIS_TEST_URL` on 6390), after the review fixes: 37
  files / 352 tests passed, 0 skipped (344 before). `llm-prompt-retention.pg.test.ts` 24: plan from
  the partial index in index order (8 cases: cut-off or not, first batch or after a cursor, dry run
  or not), the cut-off to the minute (before/at purged, after kept), a throwing checkpoint stops
  after the first batch, two overlapping runs (race barrier) empty each row once, a dry run in
  batches of 2 through equal timestamps with microseconds counts each row once, the job itself on
  the real table, dry run changes nothing, plus the feat-065 tests.
- `make test-redis`: 16 files / 147 tests passed, 0 skipped. New
  `purge-llm-prompts-cli.redis.test.ts` (4): purges under the lease and frees it, state key
  untouched; busy → 75 without purging; an error frees the lease; interrupted → 130.
- Unit: `llm-prompt-retention.spec.ts` (schedule, both plans, dry run, refusal on config error);
  `jobs/index.spec.ts` covers the Р13 bound for both jobs.
- Mutations after the review (each fails the test that guards it): no `checkpoint()` → the
  checkpoint and job tests; `<=` → `<` → the cut-off test; `ORDER BY id` → all 8 plan tests; no
  outer `final_prompt <> ''` → the overlap test; the cursor truncated to milliseconds → the
  microsecond test (the dry run loops: timeout); the cursor without the id tie-break → the same
  test.
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
