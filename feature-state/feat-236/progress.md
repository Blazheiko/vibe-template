# feat-236 Notification Center — progress

Plan: `docs/plan/notification-center-plan.md` (rev. 3.1). Tasks:
`docs/plan/notification-center-tasks.md` (rev. 2). Branch `feat/notification-center`.
Registry: #730 (not-started), #731 (in_progress).

## Current state

- Baseline on `cb07095` (`./init.sh`): green. backend 3330, frontend 739, api-playground 115,
  landing 103. `make test-pg` 452 passed / 0 skipped, `make test-redis` 174 passed / 0 skipped.
- T0a–T10 done. Next: review of the implementation PR, then "Mark feat-236 done".
- After T6: backend 3374, `make test-pg` 479 (incl. 12 repository, 8 HTTP, 7 retention tests),
  `make test-redis` 176, shared 107, frontend 759.

## Tasks

- [x] T1 shared catalog and contracts (`4ccc828`)
- [x] T2 tables and migration (`08510fb`, `a089233`)
- [x] T3 repositories (`f75d62c`)
- [x] T4 notify and call sites (`d4c96ca`)
- [x] T5 HTTP API and signals (`f9fa070`)
- [x] T6 notifications-retention job (`c0a0ff6`)
- [x] T7 frontend (`7b94fc6`)
- [x] T8 e2e (`80ab1e3`)
- [x] T9 docs (`79c65e7`)
- [x] T10 verification

## Deviations from the task list (to reflect in docs)

- No new `isPgBigintId` in shared: the backend already has `parseEntityId`
  (`controllers/shared/parse-id.ts`, feat-161); the query/body schemas check the form
  (`^[1-9]\d{0,18}$`), the controller the bigint bound before SQL.
- Out-of-range `before`/`upTo` and a locked or absent channel answer **400** (reasons
  `invalid_cursor`, `invalid_up_to`, `channel_locked`, `channel_unavailable`), not 422: the
  `AppError` set has no 422; 422 stays for schema validation (e.g. `limit=51`). A path id outside
  bigint is the 404 of a missing notification.
- `userNotificationService.security` keeps its event names (`'password_changed'`, …) and maps them
  to the catalog kinds; params became typed and required where the kind needs them. Keeps the
  dozens of auth tests that assert those names valid.
- `asNotificationProvider` (own module `notification-provider.ts`) narrows a stored provider id;
  a provider outside the catalog sends no notification (logged), the mail still goes.
- The bus is loaded lazily in `notification-service.ts` (first signal): importing it eagerly made
  every sender open Redis clients at import time and broke the mocks of ~130 auth tests.
- `notificationContracts` is exported from `shared/contracts` since T5 (route test requires a
  route per contract).

## Files modified

shared: `src/notifications/*`, `src/schemas/notifications/*`, `src/schemas/query/notifications.ts`,
`src/responses/notifications-controller.ts`, `src/contracts/notifications.ts`, push-subscription
schemas/response, broadcast events. backend: schema, relations, migration
`20261120170831_notification_center`, repositories `notification-repository.ts`,
`notification-preference-repository.ts`, services `notification-service.ts`,
`notification-push-texts.ts`, `notification-center-service.ts`, `notification-provider.ts`,
`notifications-retention-service.ts`, push sender, user-notification-service, auth call sites,
controller `notification-controller.ts`, routes, contract schemas, bus events, retention job and
config, `.env.example`. frontend: ws guards, push store.

## Notes for Next Session

- PG/Redis suites run against the local containers `vibe-sched-pg` (127.0.0.1:5440) and
  `vibe-sched-redis` (127.0.0.1:6390) via `PG_TEST_URL` / `REDIS_TEST_URL`.

## Evidence of Completion

Local, on `79c65e7` (macOS, Node 24):

- `make check`: green (exit 0). shared 107 (was 99), backend 3374 (was 3330), frontend 826 (was
  739), api-playground 115, landing 103, documentation 26; format, typecheck, lint,
  `check-bundle-graph: 664 modules, no schema and no validator library`.
- `make test-pg` (PG_TEST_URL on pgvector/pg16): **479 passed, 0 skipped** (53 files; was 452).
  New: `notifications.pg.test.ts` 12, `notification-http.pg.test.ts` 8,
  `notifications-retention.pg.test.ts` 7.
- `make test-redis` (REDIS_TEST_URL on redis 7): **176 passed, 0 skipped** (19 files; was 174).
- `pnpm --filter frontend test:e2e`: 108 passed (was 103).
- `pnpm --filter frontend test:e2e:live`: full run 28 passed + the 3 new notification specs, which
  failed on two test-side waits in that run; after the fix `e2e-live/notifications.spec.ts` 3
  passed.
- `pnpm docs:build && pnpm docs:verify`: green.
- `job:run notifications-retention` on a scratch database migrated to this branch, seeded with
  2500 unread + 300 read notifications 100–120 days old and 7 new: `--dry-run` matched 2800,
  changed 0 (2807 rows left); then the real run matched 2800, changed 2800 (7 left). Scratch
  database dropped.
- Mutations (each applied, the named test run, then reverted), all killed:
  `user_id` only in the SELECT of markRead → foreign read leaves the row unread (PG);
  drop `dirty` → signal during a read in flight; push only with a stored row and open URL without
  a row → failed insert test; `notify` throwing synchronously → security-mail-independence;
  `LIMIT` after `COUNT` → cap of 100; read-all without the bound → `id <= upTo`; locked channel
  not checked → HTTP preferences test; push ignoring preferences and a failed read falling back
  to the default → sender category tests; store applying an older count → reverse-order and
  previous-account tests; no read on `ws_ready` → missed-signal test; Escape without closeList →
  bell test; a lost "mark read" answer applied locally → store test.
- Golden path, covered against the real backend by `e2e-live/notifications.spec.ts` (two browsers):
  a sign-in elsewhere shows the badge in both without a reload; opening it lands on
  `/account#sessions` scrolled to the section and clears the other browser's badge; a browser
  offline during a sign-in catches up after its socket reconnects (badge and open list); a
  notification link opened without a session signs in and lands on the section, read. Support
  push turned off and the locked security email: HTTP PG tests and the mocked e2e. Not clicked by
  hand in a desktop browser; push delivery to a real push service is unchanged code (web-push)
  and was not exercised.
