# feat-228: Scheduler Shutdown Test Race

Owner: Blazheiko · Branch: `test/scheduler-shutdown-flaky`

## Current state

Done; test-only change. Ready for review.

## Cause

`scheduler-shutdown.pg.test.ts` (feat-222) waited for B's `b-first` row in the database and then
asserted at once that `outcomesB` contained `ok`. The scheduler logs a run's outcome only after
`run()` returned and the success was written to Redis (`scheduler.ts`: `report()` follows
`await state.recordSuccess(…)`), so the 20 ms database poll could see the row first. It failed
locally 3 times in about 6 full `make test-pg` runs: "expected [ 'skipped-locked', …(74) ] to
include 'ok'".

## Change

The test waits for `ok` in `outcomesB` with its `waitFor` (5 s), then asserts `skipped-locked`.
No production code changed.

## Evidence of Completion

- Deterministic reproduction: a temporary 300 ms delay in B's `run()` after its INSERT (not
  committed). Old test: both scenarios fail with "expected [ 'skipped-locked', …(73) ] to include
  'ok'", the message seen in the flaky runs. Fixed test: 2/2 pass.
- Fixed test in isolation: 10 runs, 10 passed.
- `make test-pg` (throwaway `pgvector/pgvector:pg16` on 5440, `REDIS_TEST_URL` on 6390): 37
  files / 340 tests passed, 0 skipped.
- `prettier --check`, `eslint` on the file: clean.
