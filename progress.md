# feat-147 — Push Log Isolation (V01)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V01), tasks: `docs/plan/code-review-2026-11-10-tasks.md`
(V01.S–V01.X). Finding M2 of `docs/plan/code-review-2026-11-10-report.md`.

## Goal

A push subscription keeps its id when it moves to another account (same browser, account switch).
The subscription list and the statistics read its log by `subscription_id` only, so the new owner
saw the previous owner's notification titles and send counts. Every read of the log is now scoped
by the log's `user_id` as well.

## State

Done, waiting for review and merge.

## Files modified

- `packages/backend/src/app/repositories/notifications/push-notification-log-repository.ts` —
  `countsBySubscription` and `latestBySubscriptionIds` take `userId` and filter by it.
- `packages/backend/src/app/repositories/notifications/push-subscription-repository.ts` —
  `findByUserIdWithLogs` passes the owner.
- `packages/backend/src/app/services/statistics/push-subscription-statistics-service.ts` —
  `getPushSubscriptionStatistics` passes the owner.
- `packages/backend/src/app/repositories/notifications/push-data.pg.test.ts` — new block "log of a
  subscription that moved to another account" (4 tests), two existing calls updated.
- `documentation/backend/web-push-notification.md`, `documentation/en/backend/web-push-notification.md`
  — the log of the previous owner stays theirs after a move.

## Evidence of Completion

### V01.T — RED (before the fix)

`PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres pnpm exec vitest run --config vitest.pg.config.ts src/app/repositories/notifications/push-data.pg.test.ts`

```
 ❯ src/app/repositories/notifications/push-data.pg.test.ts (16 tests | 3 failed)
   × the subscription list of the new owner has only their own log
     AssertionError: expected [ 'B: test push', …(2) ] to deeply equal [ 'B: test push' ]
   × the statistics of the new owner count only their own sends
     AssertionError: expected { totalNotifications: 3, …(8) } to match object { totalNotifications: 1, …(3) }
   × keeps the log of the previous owner: they see it again after a move back
     AssertionError: expected [ 'A: new sign-in', …(2) ] to deeply equal [ 'A: new sign-in', …(1) ]
```

The third channel, `getLogsBySubscriptionId`, was already scoped by owner: its test was green before
the fix, as the report expected, and stays as a regression test.

### After the fix

- PG suite of the group (`push-data.pg.test.ts` + `controllers/http/notifications`): 2 files, 39
  tests passed, none skipped.
- `pnpm format:check`, `pnpm typecheck`, `pnpm lint`: clean.
- `pnpm test`: backend 192 files / 2562 tests, frontend 34 files / 400 tests, all passed.
- `pnpm docs:build && pnpm docs:verify`: `verify-dist: all checks passed`.

### Manual verification

Not done in a browser: the path is covered end to end by the PG test on a real PostgreSQL 16 with
pgvector (repository → service). The browser scenario "A → logout → B" belongs to feat-148 (V02.4).

## Notes for Next Session

- feat-148 (V02) and feat-156 (V10) depend on this feature.
- The test database for the PG suite ran in a local container `vibe-test-pg`
  (`pgvector/pgvector:pg16`, port 55433): the local PostgreSQL 15 has no pgvector.
