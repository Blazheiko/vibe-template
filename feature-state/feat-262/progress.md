# feat-262 progress: Shared Entity Id Validator

Plan: `docs/plan/branded-types-plan.md` (rev. 5), tasks T1–T9 in `docs/plan/branded-types-tasks.md` (v2.1).
Status PR: #837 (`in_progress`, merged). Branch: `fix/single-entity-id-validator`.

## State

- T1: `./init.sh` exit 0 on `6b2c96c` (backend 3742, frontend 1017, shared 149 tests passed).
- T2: `entity-id-inputs.spec.ts` pinned the "now" column (58 tests, commit `95f727b`). The llm-usage row of the plan
  was corrected in the same commit: `'0x10'`, `'-5'`, `' 1'` filtered by 16, -5, 1; only `'abc'` and blanks dropped
  the filter.
- T3: `shared/brand` (`Brand`, `MAX_ENTITY_ID`, `isValidEntityId`), export `./brand`, `ENTITY_ID_PATTERN` limited to
  19 digits, `brands/type-checks.ts` (two-way equality with `EntityIdSchema.infer`; checked that a mismatch fails the
  build).
- T4: `EntityIdStringSchema` (pattern + `isValidEntityId`); `EntityIdSchema` brands it. Local id regexes replaced in
  `query/support.ts`, `query/admin-audit-events.ts`, `query/notifications.ts`, `notifications/requests.ts`,
  `responses/notifications-controller.ts`; `NOTIFICATION_ID_PATTERN` removed. `ProfileRevisionSchema` /
  `REVISION_PATTERN` unchanged.
- T5: `parseEntityId` = `isValidEntityId` + `BigInt`; `decodeAuditCursor` uses `isValidEntityId`;
  `vendor/utils/helpers/entity-id.ts` removed (`generate-ws-token-service` uses `isValidEntityId`); the `id > 0n`
  wrappers of passkey and notification controllers removed.
- T6: unlink parses `payload.id` (404 like the service for a non-id); llm-usage: no `.trim()`, `''`/absent = no
  filter, any other non-id = 400.
- T7: frontend `ws-payload-guards` uses `isValidEntityId`; spec cases for max, max + 1, `' 1'`, `0`, `007`.
- T8: `entity-id-inputs.spec.ts` rewritten to the "after" column (104 tests); PG tests updated to the new contract
  (`notification-http`: `before`/`upTo` past bigint, `0`, `007` → 422; `admin-audit-events-http`: `actorUserId` /
  `targetUserId` past bigint, `0`, `007` → 422, cursors with id `0`/`007` → 400; `support-history-http`: `before` =
  2^63 → 422). Docs (uk + en): `backend/controllers.md`, `backend/notifications.md`, `backend/audit-log.md`,
  `shared/index.md`, `reference/glossary.md`.
- Extra: `serializeArkSchema` passes `fallback.predicate` to `toJsonSchema()`, so a `.narrow()` field keeps its JSON
  Schema in the route docs (it threw before and the docs lost the whole schema); spec added.

## Deviations from the task list

- T2/T8: the "now" and "after" columns of the contract table are pinned by controller unit tests (services mocked) and
  schema tests in `app/controllers/http/entity-id-inputs.spec.ts`, not by new HTTP PG tests. The null branches live in
  the controllers, so these tests reach them directly and run locally. The existing HTTP PG suites that cover these
  routes were updated and run in CI (`pg-tests.yml`).
- PG and Redis suites run in CI only: the local PostgreSQL and Redis on 5432/6379 belong to another project.

## Files modified

- shared: `src/brand/index.ts` (new), `src/brands/ids.ts`, `src/brands/index.ts`, `src/brands/type-checks.ts` (new),
  `src/patterns/index.ts`, `src/schemas/index.ts`, `src/schemas/notifications/requests.ts`,
  `src/schemas/query/{admin-audit-events,notifications,support}.ts`, `src/responses/notifications-controller.ts`,
  `package.json`, `test/contracts.test.js`
- backend: `controllers/shared/parse-id{,.spec}.ts`, `controllers/http/{ai/usage/llm-usage,auth/passkey,
auth/sign-in-methods,notifications/notification}-controller.ts`, `controllers/http/entity-id-inputs.spec.ts` (new),
  `services/admin/audit-events-query-service.ts`, `services/auth/generate-ws-token-service.ts`,
  `vendor/utils/tooling/serialize-ark-schema{,.spec}.ts`, `vendor/utils/helpers/entity-id{,.spec}.ts` (removed),
  PG tests `admin-audit-events-http`, `notification-http`, `support-history-http`
- frontend: `utils/ws-payload-guards.ts`, `utils/__tests__/ws-payload-guards.spec.ts`
- docs: see T8

## Evidence of Completion

- `make check`: exit 0 (backend 3850, frontend 1024, shared 150, api-playground 115, landing 103, documentation 26
  tests passed; `check-bundle-graph: 762 modules, no schema and no validator library`, so `shared/brand` does not pull
  ArkType into the frontend).
- `pnpm docs:build && pnpm docs:verify`: exit 0, "verify-dist: all checks passed".
- Contract table: `entity-id-inputs.spec.ts` 104 tests (controllers with mocked services + schemas + audit cursor).
- `make test-pg` / `make test-redis`: CI jobs `test-pg` (`pg-tests.yml`) and `test-redis` (`redis-tests.yml`) of the
  implementation PR (link added after the run).
- Manual golden path: not run against a live app (no local database of this project); the routes are covered by the
  controller tests above and the HTTP PG suites in CI.

## Notes for Next Session

After the merge: "Mark feat-262 done" PR. Next feature by the task list: feat-263 (T10).
