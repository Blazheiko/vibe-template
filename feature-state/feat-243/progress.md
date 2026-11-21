# feat-243 — Roles Review Fixes 2

Second review of the roles work (feat-242 on main ce1a674, 2026-11-21, request changes).

## State

All three findings fixed; ready for review.

1. **P1 — socket opened with the old role** (`ws-connection-registry.ts`, `ws-coordinator.ts`, `ws-role-sync.ts`, `index.ts`): the server bus event `user_role_changed` now goes through `wsRoleSync.onRoleChanged`, which marks the user's connections still being opened (`markConnectingRoleStale`) before refreshing the registered ones. `handleConnected` reads the role again while its connection is marked (`takeConnectingRoleStale`), still inside the connecting window, so a revocation during the second read still closes it; from the last read to the registration nothing is awaited.
2. **P2 — stale subscribe confirmation** (`useAdminChannel.ts`): leaving bumps the stale epoch (an answer in flight confirms nothing) and a subscribe waits for the unsubscribe still running.
3. **P3 — late list answer after a role change** (`AdminUsersView.vue`): the role change keeps the immediate local update and re-reads the current selection quietly (new generation, the table stays on screen), so a first page or a next page asked for before the change is dropped.

Docs: `documentation/{,en/}backend/websocket.md`.

## Evidence of Completion

- Every new test fails on the code of `main` (checked by putting back the old source): backend 3 (`ws-registry-lifecycle.spec.ts`; the fourth, "reads once without a signal", guards the unchanged path), frontend 5 (useAdminChannel 2, AdminUsersView 3).
- `make check`: exit 0 — backend 3414, frontend 904.
- `pnpm --filter frontend test:e2e`: 119 passed, 1 failed on the first run — `admin-users.spec.ts` "a user_admin changes the role": its mock still answered the list with the old role, and the list is now read again after the change. The mock now answers with the new role and the test waits for the re-read; re-run of the file: 2 passed.
- `pnpm docs:build && pnpm docs:verify`: passed.
- No DB or Redis code changed; `test-pg` / `test-redis` and `e2e-live` (an open admin tab lowered to user) run in CI on the PR.
