# feat-155 — Online History Pagination (V09)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V09), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (V09.S–V09.X). Finding M4 of
`docs/plan/code-review-2026-11-10-report.md` and the low finding about `/admin/users`.

## Goal

The admin lists page by "one row more than the page". The online history service asked the
repository for `limit + 1` rows, the repository clamped the query to 100: a page of 100 — what the
admin UI asks for — never saw its 101st row, so there was no "Load more" and everything older than
the newest 100 connections was out of reach while `total` showed the larger number. `/admin/users`
had no cursor at all.

## State

Done, waiting for review and merge.

## What changed

- `packages/shared/src/schemas/query/common.ts` — `MAX_PAGE_LIMIT = 200`, the bound the limit
  schema already had; a shared test checks the constant and the schema literal agree.
- Online history: `admin-online-history-service.ts` clamps the page to `MAX_PAGE_LIMIT` (it was
  100 while the schema allowed 200); `user-online-repository.ts` no longer cuts the extra row off.
- Admin users:
    - query `cursor` (`AdminUserListQuerySchema`), response `nextCursor` and `hasMore`
      (`AdminUserListResponseSchema`);
    - `user-repository.listAdminUsers` pages by `id < cursor`, ordered by id descending; the total
      ignores the cursor;
    - `admin-user-service.ts` reads one row more than the page; the controller parses the cursor;
    - `AdminUsersView.vue` has "Load more"; a failed next page keeps what is shown.
- Docs (both locales): `guide/your-project.md`.

### Behaviour change to review

The admin user list is ordered by `id` descending instead of `created_at` descending. For rows
created by the application the two orders are the same (the id grows with registration); they
differ only for rows whose `created_at` was set by hand. The cursor needs an order without ties.

## Evidence of Completion

### V09.T — RED (before the fix)

`admin-pagination.pg.test.ts` on PostgreSQL 16 + pgvector:

```
 × 101 rows: a full page with a cursor, and the second page holds the last row
   AssertionError: expected { items: [ …(100) ], total: 101, … } to match object { total: 101, hasMore: true }
 × serves the largest page the query schema allows (200) the same way
   AssertionError: expected [ …(100) ] to have a length of 101 but got 100
 × reaches the 101st user through the cursor of the first page
 × a page that holds everything has no cursor
 Tests  4 failed | 2 passed (6)
```

The 99-row and 100-row cases were green before the fix and stay as regression tests.

### After the fix

- `admin-pagination.pg.test.ts`: 6 passed (99 / 100 / 101 rows at `limit=100`, `limit=200`, the
  users list through the cursor).
- `pnpm --filter backend test:pg` with `REDIS_TEST_URL`: 31 files / 272 tests passed, none skipped.
- `make check`: backend 194 files / 2612 tests, frontend 452, shared 26, api-playground 62.
- `pnpm --filter frontend test:e2e`: 88 passed, including the new
  `e2e/mock/admin-users.spec.ts` ("Loaded: 100 / 101" → Load more → "Loaded: 101 / 101"; the
  second request carries `cursor=2`).
- `pnpm docs:build && pnpm docs:verify`: passed.

### Not verified

- The admin UI against the real backend with more than 100 users: the e2e fakes the API; the
  real paging is covered by the PG test of the service.

### Notes

- The PG suite was down for a while: the Docker VM disk filled up (images and the build cache of
  the two image builds of feat-153) and the test database crashed with "No space left on device".
  The build cache was pruned with the owner's approval.

## Notes for Next Session

- feat-161 (V15) bounds the numeric ids read from the query (`cursor`, `userId`): a 30-digit
  cursor still reaches PostgreSQL and answers 500.
