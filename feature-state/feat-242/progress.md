# feat-242 — Roles Review Fixes

Review of feat-240/241 (2026-11-21, request changes), range 302f171..e046feb.

## State

All four findings fixed; ready for review.

1. **WS role read order** (`packages/backend/src/app/websocket/ws-role-sync.ts`): a read covers only the connections registered when it started (a connection opened meanwhile keeps the role it read at connect); a failed read takes part in the ordering like a successful one (`lastSettled`), so an older success no longer lifts the pause of a newer failure and an older failure no longer pauses after a newer success.
2. **Data of a lost permission** (`useAdminUserDetailModal.ts`, `AdminAuditLogView.vue`): losing `users.sensitive.read` closes the open user detail (every list that uses the composable) and drops the answer in flight; opening needs the permission. Losing `audit.read` empties the log at once, drops answers in flight (new generation) and reads the first page again with the filters the account scope allows (group / actions / target type outside it removed from the URL); gaining it reloads too.
3. **Admin channel retry** (`useAdminChannel.ts`): an event during a subscribe in flight asks for one more subscribe after the answer when that left the channel unconfirmed; `admin_channel_ready` makes the answer in flight stale (it may precede the pause).
4. **Users list** (`AdminUsersView.vue`): the answer of older filters is dropped (generation); after a role change a row that no longer matches the role filter leaves the list and the total.

Docs: `documentation/{,en/}backend/websocket.md` (read ordering).

## Evidence of Completion

- Every new test fails on the code of `main` (checked by putting back the old source): backend 3/3 in `ws-role-sync.spec.ts`, frontend 9 (useAdminChannel 2, useAdminUserDetailModal 3, AdminAuditLogView 2, AdminUsersView 2; the third AdminUsersView test and the third useAdminChannel test are guards of the unchanged path).
- `make check`: exit 0 — backend 3410, frontend 900, landing 103, api-playground 115.
- `pnpm --filter frontend test:e2e`: 120 passed.
- `pnpm docs:build && pnpm docs:verify`: passed.
- No DB or Redis code changed (ws-role-sync reads through `userRoleService`, mocked in its spec); `test-pg` / `test-redis` run in CI on the PR.
- Manual golden path: covered by `e2e-live/roles.spec.ts` (an open admin tab lowered to user) in the CI `e2e-live` job.
