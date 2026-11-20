# feat-236 Notification Center — progress

Plan: `docs/plan/notification-center-plan.md` (rev. 3.1). Tasks:
`docs/plan/notification-center-tasks.md` (rev. 2). Branch `feat/notification-center`.
Registry: #730 (not-started), #731 (in_progress).

## Current state

- Baseline on `cb07095` (`./init.sh`): green. backend 3330, frontend 739, api-playground 115,
  landing 103. `make test-pg` 452 passed / 0 skipped, `make test-redis` 174 passed / 0 skipped.
- T0a–T6 done and committed. Next: T7 (frontend).
- After T6: backend 3374, `make test-pg` 479 (incl. 12 repository, 8 HTTP, 7 retention tests),
  `make test-redis` 176, shared 107, frontend 759.

## Tasks

- [x] T1 shared catalog and contracts (`4ccc828`)
- [x] T2 tables and migration (`08510fb`, `a089233`)
- [x] T3 repositories (`f75d62c`)
- [x] T4 notify and call sites (`d4c96ca`)
- [x] T5 HTTP API and signals (`f9fa070`)
- [x] T6 notifications-retention job (`c0a0ff6`)
- [ ] T7 frontend
- [ ] T8 e2e
- [ ] T9 docs
- [ ] T10 verification

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

(pending)
