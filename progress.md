# feat-102 — Error Log Scrubbing

Plan: `docs/plan/code-review-2026-11-03-plan.md`, item R01. Branch: `fix/feat-102-error-log-scrubbing` (from `main` at `ecb23a3`).

## Current State

Implemented; PR open.

- `vendor/utils/errors/scrub-error.ts` (new): `toSafeError` builds a copy of an error with the same prototype (so `instanceof` and pino's `err.type` stay) and never changes the original.
    - DrizzleQueryError / pg DatabaseError keep only `code`, `constraint`, `table`, `column`, `schema`, `routine`, `severity`; message becomes `Failed query (params redacted)` / `Database error (code=… constraint=…)`; stack is rebuilt from that message plus the frames.
    - Any error loses `query`, `params`, `detail`, `where`, `internalQuery`, `hint`; `cause`, `AggregateError.errors` and error-valued fields are scrubbed recursively (cycles kept, depth 8); a non-error `cause` is dropped.
- `logger.ts`: `err` and `error` serializers = `stdSerializers.err(toSafeError(value))`; `sentryStream` therefore gets the scrubbed record.
- `sentry-service.ts`: `captureException` sends `toSafeError(normalizeException(err))`; the event processor replaces database messages in `exception.values` (via `hint.originalException`, for errors Sentry captures by itself) and `Failed query: …` text, and sanitizes `extra`, `contexts`, `breadcrumbs[].data` at any depth (sensitive keys, `query` + `params` pairs).
- `db/seed/describe-error.ts` reuses `SAFE_DB_ERROR_FIELDS`.

Finding corrected while implementing: drizzle-orm 1.0.0-rc.5 puts params into DrizzleQueryError only with `paramsInErrors: true` (`pg-core/async/session.js:48`), which `database/db.ts` does not set. The leak that exists today is pg's own message quoting a value (`22P02 invalid input syntax for type bigint: "…"`), folded into the log record by pino. Plan R01 lowered from high to low; the `paramsInErrors` guard stays.

## Files Modified

- `packages/backend/src/vendor/utils/errors/scrub-error.ts` (new), `scrub-error.spec.ts` (new), `scrub-error.pg.test.ts` (new)
- `packages/backend/src/vendor/utils/logger.ts`, `logger.spec.ts`
- `packages/backend/src/app/services/observability/sentry-service.ts`, `sentry-service.spec.ts` (two identity assertions now check the scrubbed copy)
- `packages/backend/src/db/seed/describe-error.ts`
- `documentation/backend/observability.md` (new section «Помилки БД у логах», serializers, Sentry sanitization)
- `docs/plan/code-review-2026-11-03-plan.md` (R01 correction)

## Evidence of Completion

- `pnpm typecheck` clean, `pnpm lint` clean, `pnpm format:check` clean.
- `pnpm test`: backend 2170 passed (173 files), frontend 400, api-playground 62.
- `pnpm --filter backend test:pg` locally (PG_TEST_URL on local PostgreSQL): 15 files / 114 tests passed, 5 files skipped by their own conditions; the new `scrub-error.pg.test.ts` ran (2 passed). Full run: CI `test-pg`.
- `pnpm docs:build && pnpm docs:verify`: all checks passed.
- Mutation check: with `logger.ts` from `main`, both `scrub-error.pg.test.ts` cases fail (the record contains the value pg quotes / the params), i.e. the tests catch a real leak.
- Manual (real PostgreSQL + real logger in `APP_ENV=prod`, via `scrub-error.pg.test.ts`):
    - app `db`: `WHERE id = '<value>'::bigint` → pg `22P02` quoting the value; the JSON log line and the Sentry payload have `code=22P02`, not the value.
    - drizzle client with `paramsInErrors: true`: duplicate email insert → the original message has the password hash and email; the log line and Sentry payload have `Failed query (params redacted)` + `code=23505`; `isUniqueViolation(original)` still true.
    - No HTTP route reproduces the leak: request validation rejects such values before the query.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the "Mark feat-102 done" PR (evidence into `feature_list.json`, delete this file).
- Next plan item: R02 (SMS attempt atomicity).
