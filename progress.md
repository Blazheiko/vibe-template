# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-067 - DB Config (in progress)
**Branch:** `fix/db-config`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase F3

## Status

### Done

- [x] Diagnosis: `ssl: false` was written into `database/pool-options.ts` and `drizzle.config.ts` (no way to encrypt the connection to a managed PostgreSQL), `db:create` / `db:seed` ignored SSL entirely, and the Drizzle SQL logger (statement + parameters, i.e. emails and identifiers) was keyed on `APP_ENV` being exactly `prod` / `production`, not on `APP_IS_PRODUCTION`
- [x] Tests first: `config/database.spec.ts` (default, the three modes, case, empty, a typo is an error, mapping to the driver option), `pool-options.spec.ts` (the setting reaches the options both pools share), `sql-logging.spec.ts`, `validate-runtime-config.spec.ts` (warning in production with `false`, silent with `true`/`require` and outside production, logged at startup), `db-config.pg.test.ts` on real PostgreSQL (statements printed in development, nothing printed for `APP_IS_PRODUCTION=true` or `APP_ENV=prod`, `PGSQL_SSL=true` makes both the main pool and the session-check pool ask for TLS — the plain-text test server refuses them)
- [x] `PGSQL_SSL` = `false` (default) | `true` (verified TLS) | `require` (TLS, certificate not verified): `config/database.ts` (`parseSsl`, `toPgSsl`), used by `pool-options.ts` (main pool and session-check pool), `drizzle.config.ts`, `db/create-database.ts`, `db/seed.ts`; any other value is a startup error; `drizzle-kit` rejects a bad value too
- [x] `getDatabaseSslWarning()` in `validate-runtime-config.ts`: a production-like environment with `PGSQL_SSL=false` logs a warning at startup
- [x] `database/sql-logging.ts`: `sqlLoggingEnabled(appConfig)` = `!isProductionLike`, used by `db.ts`
- [x] Docs: `backend/database.md`, `backend/configuration.md`, `.env.example`

### Behaviour changes to know

- `PGSQL_SSL` is a new optional variable; the default keeps today's behaviour.
- SQL logging is now off whenever `APP_IS_PRODUCTION=true`, not only for `APP_ENV=prod|production`.
- A typo in `PGSQL_SSL` stops the application (and `drizzle-kit`) instead of connecting unencrypted.

## Evidence of Completion

| Check                                      | Result                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| Tests first                                | 19 unit tests failed and `sql-logging` could not load before the change   |
| `drizzle-kit generate`                     | "No schema changes" with the new config; `PGSQL_SSL=bogus` is rejected    |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                    |
| `pnpm test`                                | backend 1398, frontend 203, api-playground 14, shared 17, docs 26; exit 0 |
| `test:pg` with Redis / without             | 138 passed / 74 passed, 64 skipped (6 new in `db-config.pg.test.ts`)      |
| `test:redis`                               | 89 passed                                                                 |
| `docs:build && docs:verify`                | passed                                                                    |

## Notes for Next Session

1. Merge this PR; then a PR flipping feat-067 to `done`
2. Next: F4 (feat-068), then F1 (feat-065)
