# feat-239 — Notification Center Review Fixes 3

## State

Done, ready to merge.

## Finding (re-review of #739)

P2: a late `loadMore()` GET started before read-all could append unread rows after it: the
first-page read after read-all can return the same cursor, so `next.value !== cursor` did not
drop the old answer.

## Fix

`packages/frontend/src/stores/notifications.ts`: `loadMore()` takes a ticket and drops its answer
when `mine.seq <= pageSeq` (a successful mark-read / read-all, or a newer first-page read, has
passed it), in addition to the account and cursor checks.

## Evidence of Completion

- Store test "a "load more" answer started before read-all is dropped though the cursor is the
  same" (`src/stores/__tests__/notifications.spec.ts`): delayed second page, read-all, first-page
  refresh with the same cursor, then the old answer; fails without the fix (row 28 appended).
- `make check`: green (frontend 833, backend 3374, landing 103, api-playground 115).
- `playwright test e2e/mock/notifications.spec.ts e2e/mock/account-profile.spec.ts`: 11 passed
  (including the phone scroll test).
- Frontend-only change: no PG/Redis/docs scope.
