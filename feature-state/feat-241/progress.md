# feat-241 Role Assignment — progress

Plan: `docs/plan/roles-permissions-plan.md` (rev. 5.1), tasks: `docs/plan/roles-permissions-tasks.md`
(U0–U5). Branch `feat/role-assignment`. Registry: #749 (in_progress). Depends on feat-240 (done, #748).

## Current State

- U0: `./init.sh` on `main` (`297630d`) green: backend 3407, frontend 879, shared 120,
  api-playground 115, landing 103, documentation 26.
- U1: `PATCH /admin/users/:id/role` (`can:users.roles.assign`, rate limit 30/min) over
  `roleAssignmentService`; `GET /admin/users` items carry `role` and `emailVerified`, filter
  `role`; HTTP matrix row; `admin-user-role-http.pg.test.ts` (5).

## Next Step

U2 (AdminUsersView: role column, filter, change-role dialog).

## Notes for Next Session

- PG/Redis suites: `PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5440/postgres
REDIS_TEST_URL=redis://127.0.0.1:6390` (local containers `vibe-sched-pg`, `vibe-sched-redis`).
- Via HTTP the last-admin rule cannot be reached by a single request (the actor is an admin and
  may not change its own role), so it stays covered by the service races of feat-240.

## Evidence of Completion

(pending)
