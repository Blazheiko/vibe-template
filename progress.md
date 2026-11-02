# feat-086 — Log 5xx AppErrors

Plan: `docs/plan/error-handling-fix-plan.md`, stage 1.

## Current state

Implemented, awaiting review. Start PR #290 merged (feat-086 → `in_progress` on `main`).

## Files modified

- `packages/backend/src/app/services/shared/report-app-error.ts` (+ spec): logs a 5xx `AppError` once as `error` with its cause; 4xx not logged; Redis-outage causes get `sentrySkip: true`.
- `packages/backend/src/app/controllers/shared/controller-error.ts` (+ spec): `mapControllerError` takes `logger` and `signal` and reports; new `mapWsControllerError` (status string + report + body). No log when the client already went away.
- `packages/backend/src/app/controllers/ws/{support,admin-ws}-controller.ts`: use `mapWsControllerError` (replaces `refuse` and the hard-coded `'403'`).
- `packages/backend/src/app/controllers/http/core/main-controller.ts`: passes the full context to `mapControllerError`.
- `packages/backend/src/app/services/ai/prompt-test-service.ts`: no own `logger.error` for the provider failure it returns (the controller logs it once).
- `packages/backend/src/vendor/utils/network/errors/redis-unavailable-error.ts` (+ spec), `src/database/redis-health.ts`, `src/app/services/shared/result-helpers.ts` (+ spec): a bare socket error code is no longer a Redis outage for an error of unknown source (`isRedisUnavailable`); `withRedis` uses `isRedisCommandUnavailable`, which still counts the codes.
- Tests: `avatar-controller.spec.ts` (new regression), `logger.spec.ts` (raw ioredis error with `sentrySkip` not captured), fake contexts in `auth-service.spec.ts`, `auth-controller.change-password.spec.ts`, `push-subscription-controller.spec.ts`.
- Docs: `documentation/backend/{controllers,observability}.md`; plan stage 1 item 4.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 1888, frontend 373, api-playground 62, shared 25, documentation 26 passed.
- `test:redis` (local Redis db 15): 89 passed. `test:pg` (local PostgreSQL + Redis): 152 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- Mutation check: with the `report` call removed from `controller-error.ts`, 3 tests fail (incl. the avatar regression).
- Manual (backend on :3099, `S3_ENDPOINT=http://127.0.0.1:9`, registered user, multipart `POST /api/avatar/upload`):
    - before the classification fix: 503 `service_unavailable` and a record with `sentrySkip: true` — S3 down was taken for Redis (bug found here, fixed in this PR);
    - after: 500 `{ code: 'internal_error', message: 'Failed to upload avatar' }`, one `error` record with `requestId`, `appError: 'Internal'`, cause `connect ECONNREFUSED 127.0.0.1:9`, no `sentrySkip`.
    - The two test users were deleted from the local database afterwards.
- Not run: `test:e2e` (no UI change, CI runs it); a manual Redis outage (would stop the shared local Redis; covered by unit tests of `reportAppError`/`logger` and the Redis suites).

## Known limitations

- `email-service.send` still logs its own failure before returning `Internal`; a caller that maps it through `mapControllerError` (`resendVerificationEmail`) logs twice. Kept: background senders rely on that log and have no controller. Stage 4 removes the pattern.
- `serviceUnavailable` without a cause (`AI provider is not configured` in prompt-test) is now logged as `error` per request — admin-only route, matches the policy table.

## Next step

Review + merge, then a "Mark feat-086 done" PR on `main` that deletes this file. Next feature: stage 2 (`classifyError`).
