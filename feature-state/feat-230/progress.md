# feat-230: Scheduler Reject Undefined

Owner: Blazheiko · Branch: `fix/scheduler-reject-undefined` · Registry PR: #699

## Current state

Done. Ready for review.

## Defect (external review, 2026-11-19)

`execute()` in `app/scheduler/scheduler.ts` caught the error of `job.run()` into `let err: unknown`
and told a failure by `err !== undefined`. A job that rejects with `undefined`
(`Promise.reject()`, `throw undefined`) therefore ended as `ok`: `lastSuccessSlot` written (the
slot not retried), no backoff, `info` instead of `error`, nothing in Sentry; `runOnce` answered
`ok`, so `job:run` exited 0. The other `catch` sites of the scheduler (`job-lease.ts`, the state
write, `stop()`, `run-job.ts`) do not decide failure from the error's value.

## Change

A `failed` flag set in the `catch`; `if (failed)` replaces `if (err !== undefined)`. The aborted
path is unchanged. `reportToSentry` already substitutes an `Error` for an empty `err`.

## Evidence of Completion

- `scheduler.spec.ts`, new block "a run that rejects without a reason", for
  `Promise.reject(undefined)` and an async `throw undefined`: the tick ends `failed`, no
  `recordSuccess`, no `lastSuccessSlot`, `consecutiveFailures` 1, `nextRetryAt` = +1 min, one
  Sentry capture with an `Error`; `runOnce` answers `failed`. All 4 fail on the old code
  ("expected [ 'ok' ] to deeply equal [ 'failed' ]") and pass with the fix.
- Scheduler tests: 7 files / 112 passed.
- `make check`: green; backend 222 files / 3135 tests.
