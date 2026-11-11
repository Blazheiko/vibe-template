# feat-156 — Push Subscription Input Bounds (V10)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V10), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (V10.S–V10.X). Finding M5 of
`docs/plan/code-review-2026-11-10-report.md`. Depends on feat-147.

## Goal

The request schemas of a push subscription took any string, while the columns are `varchar`: an
over-long value reached the INSERT and came back as a 500 with an error log. The `text` columns
had no bound at all. And the stored address of the device was whatever the client wrote into
`ipAddress`.

## State

Done, waiting for review and merge.

## What changed

- `packages/shared/src/schemas/push-subscription/create-subscription.ts`,
  `update-subscription.ts` — a bound on every string (the column's length; 255 for the two keys,
  1024 for the user agent) and on the list of notification types; `ipAddress` is no longer a
  request field.
- `packages/backend/src/app/services/notifications/push-subscription-service.ts` —
  `createSubscription` takes the address the server saw; an address that does not fit the column
  is not stored.
- `push-subscription-controller.ts` passes `context.httpData.ip`.
- `packages/frontend/src/utils/api.ts` — `ipAddress` removed from the request type (the store
  never sent it).
- Tests: `push-subscription-ownership.pg.test.ts` (+14, at the HTTP level),
  `packages/shared/test/contracts.test.js` (+1).
- Docs (both locales): `backend/web-push-notification.md`, request fields and bounds.

## Evidence of Completion

### V10.T — RED (before the fix)

`push-subscription-ownership.pg.test.ts` — the real route table and validation over HTTP, real
PostgreSQL:

```
 × answers 422 for deviceType of 51 characters and stores nothing     (500)
 × answers 422 for browserName of 101 characters …                    (500)
 × answers 422 for userAgent of 1025 characters …                     (200: a text column)
 × answers 422 for an endpoint longer than the column                 (500)
 × does not take the address from the client: `ipAddress` in the body is refused   (200)
 × stores a subscription with every field at its limit, with the address the server saw
 × answers 422 for an over-long field of an update too                (500)
 Tests  14 failed | 23 passed (37)
```

### After the fix

- `push-subscription-ownership.pg.test.ts`: 37 passed.
- `pnpm --filter backend test:pg` with `REDIS_TEST_URL`: 31 files / 286 tests passed, none
  skipped.
- `make check`: backend 2612, frontend 452, shared 27, api-playground 62.
- `pnpm --filter frontend test:e2e:live`: 12 passed (the push scenarios post a real subscription
  through the bounded schema).
- `pnpm docs:build && pnpm docs:verify`: passed.

### Not verified

- A subscription from a real browser's push service (the live e2e replaces `PushManager`); real
  P-256 keys are 87 and 22 characters, well inside the bound of 255.

## Notes for Next Session

- feat-161 (V15) continues with the bounds of the prompt and knowledge base schemas.
- feat-168 (C1) moves this route group to route contracts.
