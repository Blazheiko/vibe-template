# feat-240 Roles And Permissions Core — progress

Plan: `docs/plan/roles-permissions-plan.md` (rev. 5.1), tasks: `docs/plan/roles-permissions-tasks.md`
(T0–T9). Branch `feat/roles-permissions-core`. Registry: #744 (registered), #745 (in_progress).

## Current State

- T0: done. `./init.sh` on the branch right after it was cut from `main` (`615bdc6`):
  `make check` green (backend 3374, frontend 833, shared 118, api-playground 115, landing 103,
  documentation 26). The build step after it failed only because the T1 edits to `shared` (the
  wider role type) had already landed in the working tree while it ran; fixed in T1.
- T1: `shared/access` catalog (roles, permissions, delegation policy), role schemas from the
  catalog; `shared/test/access.test.js` (11 tests, the 125-transition table).
- T2: `user_role` enum values and the `users_staff_role_verified_email` CHECK (two migrations);
  fixture of `admin-ws-revocation.pg.test.ts` verifies the email (the only staff fixture without
  one: `admin-audit-events-http.pg.test.ts` already sets it; seed sets it);
  `users-role-schema.pg.test.ts` (15).
- T3: `can:<permission>` / `ws_can:<permission>` generated in `kernel.ts`, `admin_guard` and
  `ws_admin_guard` removed, admin groups split by permission, unsubscribe in its own WS group;
  `route-permissions.spec.ts` (HTTP and WS matrices), guard specs.

## Files Modified

See `git log` of the branch.

## Next Step

T4 (audit log restriction), then T5.

## Notes for Next Session

- PG/Redis suites run against the local containers `vibe-sched-pg` (127.0.0.1:5440) and
  `vibe-sched-redis` (127.0.0.1:6390):
  `PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5440/postgres REDIS_TEST_URL=redis://127.0.0.1:6390`.
- `make test-pg` after T2: 479 + 15 passed, 0 skipped.

## Evidence of Completion

(pending)
