# Background jobs

The backend runs maintenance jobs on a schedule inside the `app` process. While a job's lease key is not lost from Redis, the job never runs twice at the same time, however many `app` replicas run. Schedules live in the code, next to the jobs, and are covered by tests. The design and its decisions are in the internal plan `docs/plan/scheduler-plan.md` (Р1–Р13). Code: [`app/scheduler/`](https://github.com/Blazheiko/vibe-template/tree/main/packages/backend/src/app/scheduler).

## Jobs

| Job                       | Schedule (UTC)         | Timeout | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-token-cleanup`      | `{ dailyAt: '03:30' }` | `10m`   | Deletes one-time tokens and SMS challenges whose `expires_at` is before `now − AUTH_TOKEN_RETENTION` (default `7d`), in batches of 1000 ([`auth-token-cleanup.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/scheduler/jobs/auth-token-cleanup.ts)). See [Authentication](/en/backend/auth#expired-token-cleanup).                                                                                                                  |
| `llm-prompt-retention`    | `{ dailyAt: '04:00' }` | `10m`   | Empties the prompt text in `llm_text_usage` (the hash, the length and the tokens stay): with `AI_USAGE_STORE_PROMPTS=false` all text left, with `true` the text older than `AI_USAGE_PROMPT_RETENTION_DAYS`; in batches of 1000 from a partial index ([`llm-prompt-retention.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/scheduler/jobs/llm-prompt-retention.ts)). See [AI](/en/backend/ai#what-the-log-stores-from-the-prompt). |
| `audit-events-retention`  | `{ dailyAt: '04:00' }` | `10m`   | Deletes audit events whose `occurred_at` is before `now − AUDIT_EVENTS_RETENTION_DAYS` (default 365 days), in batches of `AUDIT_EVENTS_PURGE_BATCH_SIZE` ([`audit-events-retention.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/scheduler/jobs/audit-events-retention.ts)). See [Audit log](/en/backend/audit-log#retention).                                                                                                     |
| `notifications-retention` | `{ dailyAt: '04:30' }` | `10m`   | Deletes notifications, read or not, whose `created_at` is before `now − NOTIFICATIONS_RETENTION_DAYS` (default 90 days), in batches of `NOTIFICATIONS_PURGE_BATCH_SIZE` ([`notifications-retention.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/scheduler/jobs/notifications-retention.ts)). See [Notification center](/en/backend/notifications#retention).                                                                      |

## How it works

- **One loop per process.** Every `SCHEDULER_TICK` (default `30s`, each wait varies by ±20 % so replicas do not race for the lease every second) the scheduler walks the registry in order and runs at most one job at a time. Different jobs may still run at the same time on different replicas.
- **A lease per job.** A run takes `sched:lease:<job>` through [`withJobLease`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/scheduler/job-lease.ts), a lease on top of [`redis-lease.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/shared/redis-lease.ts) that renews itself while the job runs. A replica that finds it taken skips the job (`skipped-locked`). Without Redis there is no lease and no job starts (fail-closed); the tick is skipped with one `warn`.
- **The state** is the hash `sched:state:<job>`: `lastSuccessSlot`, `consecutiveFailures`, `nextRetryAt`, `lastRunAt`, `lastOutcome`, `lastDurationMs`. It is read after the lease is taken, and every write is one Lua script that first checks the lease still belongs to the writer, so a former owner cannot overwrite the state of the new one.
- **The app process.** `index.ts` starts the scheduler after the server listens (when `SCHEDULER_ENABLED`) and stops it before the pools and Redis close. `/ready` does not depend on it.

## Schedules

Typed, no string DSL ([`schedule.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/scheduler/schedule.ts)):

| Schedule               | Slots                                                                                                       | Limits                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `{ every: '15m' }`     | A UTC grid from the epoch, `floor(now / interval) * interval`: `15m` gives :00/:15/:30/:45 on every replica | A whole number of minutes, at least `1m`; one day divides by it (no `7m`) |
| `{ dailyAt: '03:00' }` | Today's `HH:MM` UTC once it has come, yesterday's before that                                               | `HH:MM` from `00:00` to `23:59`                                           |

Weekly schedules and cron syntax are not supported.

## Guarantees

- **The latest due slot runs.** A job is due when `lastSuccessSlot < currentSlot` and `now ≥ nextRetryAt`. Missed slots collapse into one run: after three days down a daily job runs once, not three times. Not every slot is guaranteed to run.
- **First start.** With no state in Redis the job runs once at once for the current slot: for `dailyAt: '03:00'` at 01:00 that is yesterday's 03:00, so a clean-up does not wait for the next morning. A lost state behaves the same.
- **A failed run may repeat.** `failed` and `timeout` raise `consecutiveFailures` and set `nextRetryAt = now + min(1m × 2^(failures − 1), maxBackoff)`, where `maxBackoff` is `min(every, 1h)` for `every` and `1h` for `dailyAt`. The backoff is shared by all replicas. A success resets it. When the state cannot be written (Redis failed, or the lease is no longer ours), the process holds the same backoff locally.
- **A run that was aborted is never a success.** If the signal was aborted when `run()` ended, or the owner check refused the success write, `lastSuccessSlot` is not written even if `run()` returned a result.

### Limits of the guarantees

- **Redis unavailable.** No job starts; the process keeps working. A running job learns of the loss through the lease deadline, and its next `checkpoint()` stops it before the next SQL step.
- **Only the state is lost** (`sched:state:*`). Every job runs once at once, as on the first start, and the backoff is reset. No overlap: the lease keys are intact.
- **A lease key is lost** (`FLUSHALL`/`FLUSHDB`, a failover to a replica without the key, eviction). Another replica may take a new lease while the old owner still runs SQL: **two runs of the same job may overlap**. The old owner learns it on its next renewal and its next `checkpoint()` stops it; its state writes are refused. Hence every job must be **safe to run as two copies at once**, not only idempotent. The app's Redis must use `maxmemory-policy noeviction`: under a `volatile-*` or `allkeys-*` policy a lease key can be evicted.
- **The database changed but the success was not recorded.** The slot stays due and the job runs again; for a clean-up that is a no-op.
- **The schedule changed between versions.** The new current slot is compared with `lastSuccessSlot`, so an extra run is possible (moving to a rarer schedule does not prevent it). A renamed job gets a fresh state and runs as on the first start; the old `sched:state:<old>` key stays until removed by hand.
- **A long event-loop block.** While the loop is blocked, the lease timers do not fire and the key can expire. `checkpoint()` refuses a new SQL step past the local deadline, but cannot protect a query whose sending was delayed after the `checkpoint()`. No bound on the overlap is promised. Hence the ban on synchronous CPU-heavy work in jobs.
- **Clocks.** Slots and `nextRetryAt` use each replica's `Date.now()`; a few seconds of skew only shift a run, and duplicates of a slot are cut off by `lastSuccessSlot`.

## Outcomes and logs

One pino record per run: `job`, `slot` (ISO), `trigger` (`schedule` / `manual`), `dryRun`, `durationMs`, `matched`, `changed`, `outcome`, `category`.

| `outcome`                           | `category` | Log, Sentry                                | State in Redis                     |
| ----------------------------------- | ---------- | ------------------------------------------ | ---------------------------------- |
| `ok`                                | `success`  | `info`                                     | `lastSuccessSlot`, backoff reset   |
| `failed`                            | `failure`  | `error`, Sentry with tags `job`, `outcome` | `consecutiveFailures + 1`, backoff |
| `timeout`                           | `aborted`  | `error`, Sentry with tags `job`, `outcome` | `consecutiveFailures + 1`, backoff |
| `lease-lost`                        | `aborted`  | `warn`                                     | unchanged                          |
| `shutdown`                          | `aborted`  | `info`                                     | unchanged                          |
| `skipped-locked`, `skipped-backoff` | `skipped`  | `info`                                     | unchanged                          |

## Shutdown

`scheduler.stop()` (from `stopHandler` in `index.ts`, before the server and the pools stop):

1. starts no new run;
2. aborts the job in flight (`outcome: shutdown`);
3. waits for it up to the drain (5 s). If the job ended, the lease is released. If not, the SQL may still be running (one statement on the main pool takes up to 12.5 s by default), so the lease is **abandoned**: the renewals stop but the key stays to its TTL, and no other replica starts in the middle of that SQL. The lease of a job is sized so that after any passed `checkpoint()` the key lives at least the longest database write plus a second.

A Redis error while releasing or abandoning is logged as `warn` and does not stop the rest of the shutdown.

## Adding a job

1. Write the work as a **service** method: jobs call services, as controllers do, and never import repositories (`layering.spec.ts` checks it). The method takes a `checkpoint` ([`Checkpoint`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/shared/checkpoint.ts), `noCheckpoint` outside jobs) and returns [`PurgeCounts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/shared/purge-counts.ts) (`{ matched, changed }`, `changed` = 0 on a dry run).
2. Define the job with [`defineJob`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/scheduler/job.ts) in `app/scheduler/jobs/<name>.ts` and add it to the registry in [`jobs/index.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/scheduler/jobs/index.ts):

```ts
import { defineJob } from '../job.js'
import { exampleCleanupService } from '#app/services/example/example-cleanup-service.js'

export const exampleCleanupJob = defineJob({
    name: 'example-cleanup', // kebab-case, unique: part of the Redis keys
    schedule: { dailyAt: '03:30' },
    timeout: '10m',
    run: (ctx) =>
        exampleCleanupService.purge({
            before: new Date(Date.now() - 7 * 86_400_000),
            dryRun: ctx.dryRun,
            checkpoint: ctx.checkpoint,
        }),
})
```

The contract of `ctx` (`{ signal, checkpoint, slot, dryRun, logger }`):

- **`checkpoint()` immediately before every SQL step**, with no `await` between the call and the query, passed down to the loop that does the work. It throws when the signal is aborted (timeout, lost lease, shutdown) or the local lease deadline has passed. A job that does not pass it on keeps working after an abort and holds its lease until the TTL.
- `signal` is for waits that take an `AbortSignal`.
- The job is **idempotent** (a failed run repeats) and **safe for two concurrent copies** (see the limits above): delete or update in batches of `… WHERE id = ANY(ARRAY(SELECT id … WHERE <condition> ORDER BY <indexed column of the condition> LIMIT n))`, never read-then-write without a condition. The condition's column needs an index, and `ORDER BY` uses that very column: the batch is then read from the index and costs `n` entries however many other rows the table has. With `IN (SELECT … ORDER BY id LIMIT n)` the PG planner may sort every row matching the condition for each batch (measured in the feat-223 review). Example: [`expired-rows.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/repositories/auth/expired-rows.ts).
- No synchronous CPU-heavy work: it blocks the uWS event loop and the lease timers.

3. **Job variables** (a retention, a batch size) go into a module of their own, `config/<job>.ts`, with a `configError` checked in [`validate-runtime-config.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/start/validate-runtime-config.ts), and into `.env.example`. A widely imported module such as `config/auth.ts` is the wrong home: the duration parser (`parseScheduleDuration`) calls `metautil` when the module loads, and every spec that mocks `metautil` and imports that config breaks (394 tests in feat-223). The startup check does not run in `job:run`, so the job itself refuses to run on its config error and changes nothing; it does not fall back to a default. Example: [`config/auth-token-cleanup.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/auth-token-cleanup.ts) and [`jobs/auth-token-cleanup.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/scheduler/jobs/auth-token-cleanup.ts).
4. **Tests.** A unit test of the job (the cut-off computed from the config, `checkpoint` and `dryRun` passed on, the refusal on a config error); [`jobs/index.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/scheduler/jobs/index.spec.ts) checks the Р13 lease bound for every registered job by itself. A PG test of the service on real tables:
    - only qualifying rows change; rows a few minutes on either side of the cut-off show that it is drawn at the right instant (an hours-sized time-zone shift fails it) and whether the comparison is strict;
    - the batch loop, with a small batch size;
    - a `checkpoint` that throws after the first batch: the next query does not run;
    - a dry run counts the same rows and changes nothing;
    - two overlapping runs, held together by [`race-barrier.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/test-support/race-barrier.ts): each row changes exactly once;
    - the plan: `EXPLAIN` of the batch statement itself, with `enable_seqscan` and `enable_sort` off (the test tables are small and not analysed), finds the index and no sort.

    Example: [`auth-token-cleanup.pg.test.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/auth-token-cleanup.pg.test.ts). Its rows expire in 2000–2001, so rows other test files leave behind never qualify.

5. **Docs**, both locales: the job in the [Jobs](#jobs) table and its variables under [Variables](#variables) on this page; the variables in [Configuration](/en/backend/configuration); the page of the domain (the tables it changes, what an end user sees change). Then check it by hand: `job:run <name> --dry-run` on seeded rows, then without `--dry-run`: the counts match.

## Manual run

```sh
pnpm --filter backend job:run <name> [--dry-run]
```

[`scripts/run-job.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/scripts/run-job.ts) takes the same lease as the scheduled run, so the two never run side by side, and prints `matched` and `changed` (`changed` = 0 with `--dry-run`). It does not change the schedule state (`lastSuccessSlot`, backoff) and needs Redis. A job disabled for the schedule (`SCHEDULER_DISABLED_JOBS`) still runs by hand, with a warning.

`pnpm` turns every non-zero exit code into `1`. Where the exact code matters (a cron wrapper that retries on `75`), run the script itself: `pnpm --filter backend exec tsx src/scripts/run-job.ts <name>` in development, `node dist/scripts/run-job.js <name>` in the built image.

| Exit code | Meaning                                                       |
| --------- | ------------------------------------------------------------- |
| `0`       | `ok`                                                          |
| `1`       | `failed`, `timeout`, `lease-lost`, or a wrong argument        |
| `75`      | busy: the job runs elsewhere (`EX_TEMPFAIL`), try again later |
| `130`     | interrupted (SIGINT/SIGTERM)                                  |

## Variables

| Variable                  | Default | Description                                                                               |
| ------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `SCHEDULER_ENABLED`       | `true`  | Whether this process runs the scheduler; `false` keeps it off on a replica.               |
| `SCHEDULER_TICK`          | `30s`   | How often the jobs are checked: a duration from `5s` to `5m`.                             |
| `SCHEDULER_DISABLED_JOBS` | empty   | Comma-separated job names the schedule skips. An unknown name stops the startup (a typo). |

Variables of individual jobs:

| Variable                         | Job                       | Default | Description                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_TOKEN_RETENTION`           | `auth-token-cleanup`      | `7d`    | How long a one-time token or SMS challenge is kept after `expires_at`; a duration (`7d`, `12h`). An invalid value stops the server start, and the job, `job:run` included, refuses to run with it ([`config/auth-token-cleanup.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/auth-token-cleanup.ts)). |
| `AI_USAGE_STORE_PROMPTS`         | `llm-prompt-retention`    | `false` | `false`: the job empties all prompt text left in the table; `true`: only the text past the retention ([`config/ai.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/ai.ts)).                                                                                                                              |
| `AI_USAGE_PROMPT_RETENTION_DAYS` | `llm-prompt-retention`    | `30`    | How many days to keep the prompt text when it is stored. With an AI configuration error the server does not start, and the job, `job:run` included, does not run.                                                                                                                                                                             |
| `AUDIT_EVENTS_RETENTION_DAYS`    | `audit-events-retention`  | `365`   | How many days an audit event is kept; a whole number, at least 30. An invalid value stops the server start, and the job refuses to run with it ([`config/audit-events-retention.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/audit-events-retention.ts)).                                            |
| `AUDIT_EVENTS_PURGE_BATCH_SIZE`  | `audit-events-retention`  | `1000`  | Rows one DELETE of the job removes, 1 to 10000.                                                                                                                                                                                                                                                                                               |
| `NOTIFICATIONS_RETENTION_DAYS`   | `notifications-retention` | `90`    | How many days a notification is kept; a whole number, at least 7. An invalid value stops the server start, and the job refuses to run with it ([`config/notifications-retention.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/notifications-retention.ts)).                                           |
| `NOTIFICATIONS_PURGE_BATCH_SIZE` | `notifications-retention` | `1000`  | Rows one DELETE of the job removes, 1 to 10000.                                                                                                                                                                                                                                                                                               |

The scheduler variables are read by [`config/scheduler.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/scheduler.ts); an invalid value is the startup error `Invalid scheduler configuration: ...`. See also [Configuration](/en/backend/configuration#background-jobs).
