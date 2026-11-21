# feat-241 Role Assignment — progress

Plan: `docs/plan/roles-permissions-plan.md` (rev. 5.1), tasks: `docs/plan/roles-permissions-tasks.md`
(U0–U5). Branch `feat/role-assignment`. Registry: #749 (in_progress). Depends on feat-240 (done, #748).

## Current State

- U0: `./init.sh` on `main` (`297630d`) green: backend 3407, frontend 879, shared 120,
  api-playground 115, landing 103, documentation 26.
- U1: `PATCH /admin/users/:id/role` (`can:users.roles.assign`, rate limit 30/min) over
  `roleAssignmentService`; `GET /admin/users` items carry `role` and `emailVerified`, filter
  `role`; HTTP matrix row; `admin-user-role-http.pg.test.ts` (5).

- U2: `AdminUsersView` role column and filter, "Change role" only for rows the delegation policy
  allows (never the own one), `RoleChangeDialog` (allowed roles only, staff roles disabled without
  a verified email, reason texts); the detail needs `users.sensitive.read`, the log link
  `audit.read.account`; unit `role-options` (8), `RoleChangeDialog` (2), mocked e2e (2).
- U3: live e2e `roles.spec.ts` (4): the admin gives `kb_editor` from the list; the editor sees only
  the knowledge base; a support operator reads but cannot write and has no connection history; an
  open admin tab lowered to `user` goes to `/account` without a reload; staff roles disabled for an
  unverified account.
- U4: docs in both locales, template matrix, recommendations item 6 marked implemented.

## Next Step

Review of the implementation PR; then the done PR.

## Notes for Next Session

- PG/Redis suites: `PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5440/postgres
REDIS_TEST_URL=redis://127.0.0.1:6390` (local containers `vibe-sched-pg`, `vibe-sched-redis`).
- Via HTTP the last-admin rule cannot be reached by a single request (the actor is an admin and
  may not change its own role), so it stays covered by the service races of feat-240.

## Evidence of Completion

Local, on `65f53ed` (macOS, Node 24, PG and Redis in the local containers):

- `make check`: green — backend 3407, frontend 889, shared 120, api-playground 115, landing 103,
  documentation 26.
- `make test-pg`: **526 passed, 0 skipped** (57 files; +5 `admin-user-role-http.pg.test.ts`).
- `make test-redis`: **178 passed, 0 skipped**.
- `pnpm --filter frontend test:e2e`: 120 passed; `test:e2e:live`: 34 passed (+4 `roles.spec.ts`).
- `pnpm docs:build && pnpm docs:verify`: all checks passed.
- Golden path: the live e2e drives it through the real UI and backend (give a role in the dialog,
  sign in as that role, lower an open tab); by hand the dialog was checked in the same build.
- Not reachable over HTTP: `409 last_admin` (the actor is an admin and may not change its own
  role); covered by the service races of feat-240.
