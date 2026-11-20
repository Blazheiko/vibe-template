# feat-236 Notification Center — progress

Plan: `docs/plan/notification-center-plan.md` (rev. 3.1). Tasks:
`docs/plan/notification-center-tasks.md` (rev. 2). Branch `feat/notification-center`.
Registry: #730 (not-started), #731 (in_progress).

## Current state

- T0a, T0b done. Baseline on `cb07095` (`./init.sh`): green. backend 3330, frontend 739,
  api-playground 115, landing 103. `make test-pg` 452 passed / 0 skipped, `make test-redis` 174
  passed / 0 skipped.

## Tasks

- [ ] T1 shared catalog and contracts
- [ ] T2 tables and migration
- [ ] T3 repositories
- [ ] T4 notify and call sites
- [ ] T5 HTTP API and signals
- [ ] T6 notifications-retention job
- [ ] T7 frontend
- [ ] T8 e2e
- [ ] T9 docs
- [ ] T10 verification

## Files modified

(none yet)

## Notes for Next Session

- PG/Redis suites run against the local containers `vibe-sched-pg` (127.0.0.1:5440) and
  `vibe-sched-redis` (127.0.0.1:6390) via `PG_TEST_URL` / `REDIS_TEST_URL`.

## Evidence of Completion

(pending)
