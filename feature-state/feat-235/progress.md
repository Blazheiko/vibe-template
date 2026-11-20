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

- **The actor (or the request) is a required parameter** of every audited service since the
  review of 2026-11-20; the existing auth tests (PG race suites included) were changed
  mechanically to pass `testUserActor()`, `testProofHolder(proof)` or `testRequest()` — no
  assertion changed. Earlier it was optional with a fallback actor without a request id.
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

## Review 2026-11-20 (REQUEST CHANGES on `668cba6`) — fixes

1. **Stale answer in the log page** (high): every first page starts a new generation; an answer
   of an older one is dropped (`AdminAuditLogView.vue`). Test "drops the answer of a page asked
   for before the filters changed"; removing the guard fails it.
2. **Prompt cache could go back to an older row** (high): the cache keeps the audit stamp of the
   change each row came from and takes a row only from a newer change; an edit without changes
   publishes nothing. Unit tests "the answer of an older commit arriving last…" and "an edit
   without changes does not publish…" (both fail on a mutation of the guard);
   `prompt-audit.pg` race now also checks the final cache.
3. **Out-of-range ids and impossible cursor dates gave 500** (medium): `actorUserId` /
   `targetUserId` through `parseEntityId` (400), the cursor id against the `bigint` maximum and
   its date against the calendar (400). The HTTP test asserts exact codes (400 / 422); the
   February-30 cursor answered 500 before the fix.
4. **Repeated `action` lost in the UI** (medium): all values kept in the form (multi-select), the
   URL and the requests of next pages; test "keeps every action of the URL".
5. **Attribution contract not enforced by the service** (medium): actor / request required,
   `requestId: string` in the `user` and `proof_holder` types and checked by `record`; the
   catalog lists the proofs of each action (`proofs`), and `record` refuses a missing, wrong or
   superfluous proof. Tests in `audit-service.spec.ts` and `shared/test/audit.test.js`.
6. `kb.article.created`: the stamp is taken after `INSERT … RETURNING`.

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

After the review fixes (2026-11-20): `make check` green (backend 3328, frontend 739, shared 99,
landing 103, api-playground 115, docs 26, bundle graph clean); `make test-pg` 50 files, **452
executed, 0 skipped**; `make test-redis` **174**; `test:e2e:live` **27 passed**;
`admin-audit-log` mocked e2e passed; `docs:build && docs:verify` passed. One live run failed
`account-profile.spec.ts` ("a name with markup…"): the local throwaway database `vibe_e2e_live`
had 132 users from earlier runs, so the seeded account was off the first page of 100 of the
admin list. Not a code issue (CI creates the database fresh); after dropping that database the
whole live suite passed.

Before the review:

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
