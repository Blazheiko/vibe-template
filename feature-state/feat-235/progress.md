# feat-235 · Audit Log — progress

Plan: `docs/plan/audit-log-plan.md` (rev. 3), tasks: `docs/plan/audit-log-tasks.md` (rev. 2).
Branch: `feat/audit-log`. Status PR: #726 (merged).

## Current state

T0–T10 verification done; implementation PR open, waiting for review.

| Task | Commit    | What                                                                |
| ---- | --------- | ------------------------------------------------------------------- |
| T1   | `6f06720` | `shared/audit`: catalog, projections, key check, API schemas        |
| T2   | `387e6ab` | `audit_events`, indexes, `audit_events_no_update` trigger           |
| T3   | `cb23511` | repository, `auditService.stamp/record/logCommitted`, actors        |
| T4   | `06551d1` | prompts, articles, screenshots                                      |
| T5   | `659aec4` | sign-in methods, sessions, phone link transaction, seed             |
| T6   | `cf758d1` | `GET /admin/audit-events` (+ T6a order tests in the same HTTP file) |
| T7   | `83a1060` | `audit-events-retention` job                                        |
| T8   | `28572ca` | `/admin/audit-log` page                                             |
| T9   | `f5b3b95` | documentation, both locales                                         |

## Deviations from the task list (deliberate)

- **Actor parameter is optional in the auth services** (`logoutAll`, `changePassword`,
  `confirmPhoneLink`, `revokeOthers`, `unlink`, `resetPassword`, `completePhonePasswordReset`;
  `request?` for `verifyEmail`, `handleCallback`, `confirmLink`). Without it the service builds an
  actor without a request id (`userActorWithoutRequest` / `proofHolderWithoutRequest`) and still
  writes the event. This keeps the existing PG race tests (T5.8) unchanged; every controller
  passes the request actor.
- **Screenshot rollback**: the task list describes a `reachedCommit` flag. With the swap
  transaction owned by `supportKnowledgeRepository.replaceScreenshot` (kept so that
  `storage-object-replacement.pg.test.ts` stays unchanged), the audit work runs in its
  `inTransaction` callback and an error thrown there is wrapped as `RolledBackBeforeCommit`: a
  known rollback, the new object is removed. A PostgreSQL rejection is removed as before; an
  error without an answer keeps the object (feat-130). Same semantics as the flag.
- **T6a lives in `admin-audit-events-http.pg.test.ts`** (describe "the order of an object
  history"), not in a separate `audit-order-http.pg.test.ts`: one server start for both.
- **e2e-live**: the app has no "sign out everywhere" button; the live test changes the password in
  the account page and calls `POST /api/auth/logout-all` as `session-revocation.spec.ts` does.
- **feat-100 test updated consciously** (`register-race.pg.test.ts`, phone link): the loser's
  challenge now stays unconfirmed (`confirmedAt` null), because the unique-index failure rolls back
  the confirmation with the transaction. Unit contracts of `confirmPhoneLink`
  (`auth-service.contract.spec.ts`, `auth-phone-foundation.spec.ts`) follow the new flow (lock,
  re-check, `update` in the transaction).
- Unit specs that mock repositories mock `auditService` too (the audit write of each point is
  covered by its `*.pg.test.ts`); `logout-all.redis.test.ts` (no database) stubs the clock and the
  insert.
- Seed: `SeedStore.insertUser` returns the events; `seedCommitted` logs them after the outer
  transaction (`db/seed/seed-transaction.ts`).

## Mutations (Р13)

| Mutation                                                 | Fails                                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `withTransactionResult` → `withTransaction` (phone link) | `phone-link-audit` "a refusal after the confirmation…" (run)                                          |
| `stamp` before the lock (prompt)                         | `admin-audit-events-http` T6a prompt order (run)                                                      |
| retention `<` → `<=`, `ORDER BY id`                      | `audit-events-retention.pg` strictness, dry run, plan (run)                                           |
| remove `record` from `logoutAll`                         | `sign-in-audit.pg` "writes one auth.sessions.revoked_all", "a failed insert keeps the previous token" |
| prompt `FOR UPDATE` → plain read                         | `prompt-audit.pg` race "started first but locked second"                                              |
| article `UPDATE` without comparing with the row          | `kb-audit.pg` "no UPDATE … keeps the vector", "category change alone"                                 |
| new S3 object removed only on `isServerRejection`        | `kb-audit.pg` "a failed audit insert … takes the new object back"                                     |
| remove the number re-check under the lock                | `phone-link-audit.pg` "two numbers linked at once"                                                    |
| `confirmChallenge` outside the transaction               | `phone-link-audit.pg` unique index, refusal after confirmation                                        |
| `logCommitted` inside the transaction (prompt)           | `prompt-audit.pg` positive test (two log lines instead of one)                                        |
| bound 4096 (shared rebuilt)                              | `audit-service.spec` worst case of `kb.article.updated` and the measured-size test                    |

Every mutated file was restored from its copy; `git status` clean after the runs. Note: the
backend reads `shared` from `dist`, so a mutation of `shared/src` needs `pnpm --filter shared build`.

## Notes for Next Session

- PG/Redis for local runs: `PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5440/postgres`,
  `REDIS_TEST_URL=redis://127.0.0.1:6390` (containers `vibe-sched-pg`, `vibe-sched-redis`).
- `job:run` was exercised on a throwaway database in that container, never on the dev database.

## Evidence of Completion

- T0 baseline `./init.sh` on `d911394`: backend 3237, frontend 732, landing 103, green.
- `make check` on `f5b3b95`: green — shared 98, documentation 26, api-playground 115, landing 103,
  frontend 737, backend 3324; `check-bundle-graph: 644 modules, no schema and no validator
library`.
- `pnpm docs:build && pnpm docs:verify`: `verify-dist: all checks passed`.
- `job:run audit-events-retention` on a throwaway database with 2500 events older than 400 days
  and 30 recent: `--dry-run` → `matched 2500, changed 0`; real run → `matched 2500, changed 2500`;
  30 rows left.
- `make test-pg` (PG_TEST_URL and REDIS_TEST_URL set) on `f5b3b95`: 50 files, **452 executed, 0
  skipped**.
- `make test-redis`: 19 files, **174 executed, 0 skipped**.
- `pnpm --filter frontend test:e2e`: **103 passed**.
- `pnpm --filter frontend test:e2e:live`: **27 passed** (includes `audit-log.spec.ts`).
- Golden path: exercised by `e2e-live/audit-log.spec.ts` against the real backend — an article
  edited in the knowledge-base UI and a prompt changed by `PUT /prompts/:type` appear under the
  admin's name in `/admin/audit-log` (history link from the article, `group` + `targetId`
  filters); a password change in the account page and logout-all appear by `targetUserId`. Not
  checked by hand: finding an event by its request ID in the server log output (covered by the
  `logCommitted` unit and PG tests only), and unlinking a sign-in method in the UI (PG test only).
