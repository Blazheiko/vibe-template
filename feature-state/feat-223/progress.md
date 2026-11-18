# feat-223: Expired Auth Token Cleanup Job

Owner: Blazheiko · Branch: `feat/auth-token-cleanup-job` · Status PRs: #684, #686 (merged) · Implementation PR: #685

Plan: `docs/plan/scheduler-plan.md` (feat-223), tasks T13–T18 of `docs/plan/scheduler-tasks.md`.

## Current state

T13–T18 done; status `review` (#686). An independent review of #685 found no wrong-row bug; its
findings are fixed below. Next: merge #685, then "Mark feat-223 done".

## T14 audit: who reads expired or used rows

| Table                                             | Reads                                                                                                                                                                     | Depends on an old row?                                                                                                                                                                                     | Minimum safe retention                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `email_verifications`, `email_link_verifications` | `findByTokenHash` in `findUsableToken` (`one-time-token.ts`); `markUsed`/`burn`/`invalidatePendingByUserId` only change pending rows                                      | Only the answer: a used row answers "used", an expired one "expired"; a deleted one "Verification link is invalid". No throttle or counter reads rows                                                      | any positive (TTL 24 h)                                   |
| `password_reset_tokens`                           | same                                                                                                                                                                      | same; a deleted token answers `invalid_token`                                                                                                                                                              | any positive (TTL 1 h)                                    |
| `oauth_link_verifications`                        | same, plus `invalidatePendingByUserIdAndProvider` (pending only)                                                                                                          | same; a deleted token answers `invalid_token`                                                                                                                                                              | any positive (TTL 30 min)                                 |
| `sms_auth_challenges`                             | `findById` (register/link/reset confirm and complete), `findLatestPendingForPhoneFlow` / `findPendingForPhoneFlow` (resend cooldown, invalidation), the guarded `UPDATE`s | `findById` of a deleted challenge answers "not found"/"invalid" instead of "no longer valid". The cooldown reads only pending rows; SMS and attempt budgets are in Redis (`consumeAuthThrottle`), not rows | above `resend_available_at − expires_at` (≤ 0 by default) |

No foreign key references these rows; no query counts them. `AUTH_TOKEN_RETENTION = 7d` confirmed;
the plan needs no change.

## What was built

- Migration `20261118183215_auth_token_expires_at_idx`: `expires_at` indexes on the four token
  tables (`sms_auth_challenges` already had one); `schema.ts`.
- `app/repositories/auth/expired-rows.ts`: `deleteExpiredBatch(before, limit)`
  (`DELETE … WHERE id = ANY(ARRAY(SELECT id … WHERE expires_at < $1 ORDER BY expires_at LIMIT $2))
RETURNING id`)
  and `countExpired(before)`; on the token repository factory and the SMS repository. The
  consumer interface `ITokenRepository` stays as it was (its mocks are untouched); the concrete
  repository types add `ExpiredRowsRepository`.
- `app/services/auth/auth-token-cleanup-service.ts`: `purgeExpired({ before, dryRun, checkpoint,
batchSize = 1000 })`, table by table, `checkpoint()` right before every query, until a batch is
  short.
- `app/scheduler/jobs/auth-token-cleanup.ts`: `{ dailyAt: '03:30' }`, `timeout: '10m'`,
  `before = now − retention`; in the registry.
- `config/auth-token-cleanup.ts`: `AUTH_TOKEN_RETENTION` (duration, default `7d`), checked in
  `validate-runtime-config.ts`; `.env.example`.
- Docs (both locales): `scheduler.md` (jobs table), `auth.md` (cleanup section with the audit),
  `database.md` (indexes, migration row), `configuration.md` (`AUTH_TOKEN_RETENTION`).

## Deviations from the task list

- `AUTH_TOKEN_RETENTION` lives in its own `config/auth-token-cleanup.ts`, not in `config/auth.ts`:
  `auth.ts` is imported by most auth code, and loading the duration parser there (it calls
  `metautil.duration`) broke 12 spec files that mock `metautil` (394 tests).
- The delete picks its batch `ORDER BY expires_at` with `= ANY(ARRAY(…))`, not `ORDER BY id` with
  `IN (…)` as T16 wrote: see the review below.
- On a real run `matched` equals `changed` (the rows this run deleted); the service does not count
  first. On a dry run `matched` is `countExpired`.

## Independent review of #685

No bug in which rows are deleted; T14 audit confirmed against the code. Fixed:

- `job:run` with an unreadable `AUTH_TOKEN_RETENTION` deleted with the 7d default (only the
  server start checked it): the job now refuses to run on the config error, deleting nothing
  (unit test).
- `ORDER BY id` + `IN (subquery)`: measured on the real schema with 300k SMS challenges and 1 %
  expired, the planner sorted all 2653 expired rows for every batch (45 ms) instead of reading
  1000 from the index (28 ms); the cost grows with the backlog. Now `ORDER BY expires_at` +
  `= ANY(ARRAY(…))`: the batch is read from `expires_at_idx` in index order.
- The index test checked `count(*)`, not the delete: it now EXPLAINs the delete itself
  (`expiredBatchDelete`) with seq scan and sort off; with `ORDER BY id` it fails.
- No test near the cut-off: rows 2 min before, at, and 2 min after it (strict `<`); with `lte` it
  fails.
- The overlap test uses `race-barrier.ts` (both runs inside their first delete before either goes
  on).
- Docs: the index wording in `database.md`; in `auth.md` the SMS cooldown holds while
  `AUTH_SMS_RESEND_COOLDOWN_SECONDS` < TTL + retention (not enforced by config).

Not changed: a `timeout`/`shutdown` run reports `matched`/`changed` 0 even after deleting rows
(the feat-222 contract carries no partial counts); the Р13 registry test is near-tautological by
construction, as T17 asked.

## Evidence of Completion

- Baseline `./init.sh` (on `main` at 9831091, before any change): green; backend 220 files /
  3119 tests, frontend 55 / 614, landing 103, api-playground 115.
- `make check` after the review fixes: green; backend 222 files / 3131 tests, frontend 55 / 614,
  landing 103, api-playground 115.
- `make test-pg` with `PG_TEST_URL` (throwaway `pgvector/pgvector:pg16` on 5440) and
  `REDIS_TEST_URL`: 37 files / 339 tests passed, 0 skipped (before the review fixes). After them:
  340 tests, 339 passed, 0 skipped, 1 failed: the flaky feat-222 test below.
  `auth-token-cleanup.pg.test.ts` (7: the cut-off to the minute, only rows before the cut-off in all five tables, batch loop,
  a throwing checkpoint stops before the next query, dry run counts the same rows and changes
  nothing, two overlapping runs delete each row exactly once, the delete of every table reads its
  batch from the `expires_at` index).
- `make test-redis` with `REDIS_TEST_URL=redis://127.0.0.1:6390/15`: 15 files / 143 tests passed,
  0 skipped.
- Mutation check: without the `checkpoint()` before a delete batch, or without the `LIMIT`, 2 of the
  6 PG tests fail each. After the review: `ORDER BY id` fails the plan test; `lte` fails the
  cut-off test.
- `pnpm docs:build && pnpm docs:verify`: `verify-dist: all checks passed`.
- Manual golden path (database `feat223_manual` on the throwaway PG, Redis on 6390): six rows per
  table expiring 30 d, 20 d, 8 d, 2 d, 1 h ago and in 1 h. `job:run auth-token-cleanup --dry-run`:
  `matched 15, changed 0`; `job:run auth-token-cleanup`: `matched 15, changed 15`; dry run again:
  `matched 0`; three rows (2 d, 1 h, future) left in every table.

## Observed, outside this feature

- `scheduler-shutdown.pg.test.ts` (feat-222) is flaky: 3 failures in about 6 local runs
  ("expected [ 'skipped-locked', …(74) ] to include 'ok'"). Cause, by reading: it waits until
  B's `b-first` row appears, then asserts at once that `outcomesB` holds `ok`; the `ok` entry is
  logged only after `run()` returns and the state Lua write, so the 20 ms poll can see the row
  first. Fix: wait for `ok` with `waitFor`. Outside feat-223; it uses its own test jobs.
- CI `e2e`/`e2e-live` failed four times today (#682, #684, #685, #686) in `playwright install-deps` (apt, exit 100) before any
  test ran; a rerun passed both times.

## Notes for Next Session

- Local PG/Redis: throwaway containers `vibe-sched-pg` (127.0.0.1:5440) and `vibe-sched-redis`
  (127.0.0.1:6390); the containers on 5432/6379 belong to another project, do not use them.
- After merge: "Mark feat-223 done"; then feat-224 (T19).
