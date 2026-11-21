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

- T4: `GET /admin/audit-events` under `can:audit.read.account`; without `audit.read` every explicit
  filter outside sign-in/sessions/user is 403 before the group/action intersection, and the
  allowed actions and `target_type = 'user'` are in the WHERE before cursor and limit (6 new PG
  tests in `admin-audit-events-http.pg.test.ts`).
- T5: `roleAssignmentService` (one advisory lock, actor and target read again under it, rules
  404/403/no-op/409 identity_unverified/409 last_admin, `user.role.changed` with the role read
  under the lock), `cli` system source, `user:set-role` CLI + `make user-role`;
  `role-assignment-service.pg.test.ts` (15) with both races.
- T6: `wsRoleSync` replaces `admin-ws-access-service` (signal + periodic pass over every user,
  numbered reads, `access_changed` after applying, admin channel paused on a failed read and
  `admin_channel_ready` after, never re-subscribed by the server); server bus events,
  `notifyServer`, `publishRemote`; `WS_ROLE_RECHECK_INTERVAL_MS` (renamed). The promotion test of
  `admin-ws-revocation.pg.test.ts` is inverted (same socket gets `access_changed`, then subscribes);
  the two DB-failure tests now expect the pause; new pause→unsubscribe and same-role reconnect tests.
- T7: `GET /account/access`; frontend `can()`/`isStaff()`/access ticket, `useAccessSync`,
  `admin-pages.ts` (router + menu), `useAdminChannel` (per socket generation, `data.status`,
  `admin_channel_ready` clears the confirmation), knowledge base / online / audit log by
  permission; mocked e2e `admin-roles.spec.ts` (8).
- T8: documentation in both locales (roles-capabilities, auth, middlewares, routing, websocket,
  configuration, audit-log, account, scripts, make, glossary, frontend, other admin_guard
  mentions), the backend-feature tutorial and skill, the backend README.
- T9: verification below; the feature is ready for review.

### Deviation from the task list

- T6 asked for a test that spawns the real `tsx src/scripts/user-set-role.ts` process. The CI jobs
  `test-pg`/`test-redis` do not build the backend `dist/`, which `#app/*` imports of a `tsx`
  script resolve to, so a spawned process cannot run there. The CLI body moved to
  `runUserSetRole` (`user-set-role-cli.ts`) and `user-set-role-cli.pg.test.ts` runs it on the
  real, never-started bus of the module; the mutation "notifyServer instead of publishRemote"
  fails it. The real process was run by hand (Evidence below).

## Files Modified

See `git log` of the branch.

## Next Step

Review of the implementation PR; then the done PR.

## Notes for Next Session

- PG/Redis suites run against the local containers `vibe-sched-pg` (127.0.0.1:5440) and
  `vibe-sched-redis` (127.0.0.1:6390):
  `PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5440/postgres REDIS_TEST_URL=redis://127.0.0.1:6390`.
- `make test-pg` after T2: 479 + 15 passed, 0 skipped.

## Evidence of Completion

Local, on `2a8cb04` (macOS, Node 24, PG and Redis in the local containers):

- `make check`: green — backend 3407, frontend 879, shared 120, api-playground 115, landing 103,
  documentation 26; format, typecheck, lint, bundle graph.
- `make test-pg` (`PG_TEST_URL` + `REDIS_TEST_URL`): **521 passed, 0 skipped** (56 files; 479
  before, new: users-role-schema 15, role-assignment-service 15, user-set-role-cli 3, audit
  account scope 6, WS revocation rewritten 13).
- `make test-redis`: **178 passed, 0 skipped** (19 files; +2 bus server events).
- `pnpm --filter frontend test:e2e`: 119 passed (new `admin-roles.spec.ts` 8).
- `pnpm --filter frontend test:e2e:live`: 30 passed (on `62d8a15`, the code is unchanged since).
- `pnpm docs:build && pnpm docs:verify`: verify-dist all checks passed.
- Mutations, each fails a named test: no advisory lock → both races (role-assignment PG); role
  from the guard instead of the locked read → lowered-actor race; `support_operator` with
  `kb.write` in the catalog → shared access test and the HTTP matrix; `user_admin` may give
  `user_admin` → delegation closure tests; `access_changed` sent before the role is applied →
  ws-role-sync spec (2); `admin_channel_ready` keeps the confirmation → useAdminChannel spec;
  no early `action` check in the account scope → audit PG (2); `notifyServer` instead of
  `publishRemote` in the CLI → user-set-role-cli PG.
- Migration by hand on a fresh database (all migrations up to the CHECK one, then an unverified
  `admin` row): `ERROR: check constraint "users_staff_role_verified_email" of relation "users" is
violated by some row`; after `UPDATE users SET email_verified_at = now()` the migration applies.
- Real CLI process (`pnpm build`, then `pnpm user:set-role` on a migrated database, Redis channel
  watched with `redis-cli SUBSCRIBE <prefix>user-events`):
  `user -> kb_editor` exit 0 and one message
  `{"event":"user_role_changed","userId":"1",...}` on the channel, audit row `system`,
  `{"source":"cli"}`; the same role again: "already has the role", exit 0, nothing written;
  unverified account to `support_operator`: `Refused (identity_unverified)`, exit 1; the last
  admin to `user`: `Refused (last_admin)`, exit 1.
- Golden path by hand in a browser (assigning a role to an open tab) is covered by the HTTP
  endpoint and the live e2e of feat-241; for feat-240 the open-socket behaviour is covered by
  `admin-ws-revocation.pg.test.ts` on a real server and the mocked e2e of the admin menu.
