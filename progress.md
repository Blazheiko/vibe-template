# feat-087 — Shared Error Classification

Plan: `docs/plan/error-handling-fix-plan.md`, stage 2.

## Current state

Implemented, awaiting review. Start PR #293 merged (feat-087 → `in_progress` on `main`).

## Files modified

- `packages/backend/src/vendor/utils/network/errors/http-error.ts` (new): abstract `HttpError` — `statusCode`, `code`, `publicMessage`, `details()`, `headers()`, `logFields()`, `logMessage`.
- `packages/backend/src/vendor/utils/network/errors/classify-error.ts` (new, + spec): `classifyError` in a fixed order — Redis outage first (503, `Retry-After: 1`, `sentrySkip`), then `HttpError`, then 500; `logClassifiedError`, `classifiedErrorBody`.
- The 7 error classes now extend `HttpError` and describe their own answer: `payload-too-large`, `malformed-body`, `unsupported-media-type`, `redis-unavailable`, `session-verification-unavailable` (vendor), `ValidationError`, `ParameterValidationError` (app/validate). Response bodies and log messages unchanged.
- `packages/backend/src/vendor/start/server.ts`: `handleError` = classify + log + `sendErrorResponse` (the 7-branch `instanceof` chain is gone).
- `packages/backend/src/vendor/utils/routing/ws-api-dispatcher.ts`: the `catch` uses `classifyError` (Redis → `service_unavailable` instead of `internal_error`; validation errors now logged at `warn`).
- `packages/backend/src/vendor/utils/network/ws-handlers.ts`: `JSON.parse` in its own `try` → `bad_request` at `warn` (was `internal_error` at `error` → Sentry); `event`/`timestamp` taken from the parsed message before validation; dead `ValidationError` branch removed.
- `packages/shared/src/errors/error-codes.ts`: `receivedContentType?: string | null` — the server already sent `null` without a Content-Type.
- Tests: `classify-error.spec.ts`, `ws-message-errors.spec.ts` (new), `ws-validation.spec.ts` (dispatcher classification).
- Docs: `documentation/backend/{request-lifecycle,websocket}.md`; `docs/plan/ws-error-envelope-plan.md` header (feat-048 is done); plan stage 2 note (details already matched `ErrorDetails`, no body change needed).

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 1910, frontend 373, api-playground 62, shared 25, documentation 26 passed. All pre-existing HTTP error tests pass unchanged (bodies and log messages preserved).
- `pnpm docs:build && pnpm docs:verify` passed.
- Mutation: letting `HttpError` win over the Redis branch fails 2 tests (classifier priority + dispatcher Redis case).
- Manual on a fresh build (`pnpm --filter backend build`, `node dist/index.js` on :3099):
    - HTTP `POST /api/auth/login` with `{not json` → 400 `bad_request` "Malformed json body", log `warn`;
    - WS `{not json` → `{ status: 'error', error: { code: 'bad_request', message: 'Malformed json body' }, data: null }`, log `warn`, no `error`;
    - WS `{ event: 'api/nope:x', timestamp: 77, payload: 5 }` → `validation_failed` with `issues`, `event: 'api/nope:x'`, `timestamp: 77` (was `event: ''`);
    - side effect seen right after start: the rate-limit Redis client was not ready yet, registration answered 503 with `sentrySkip: true` and the raw ioredis cause `Command timed out` — the feat-086 path for the rate-limit client;
    - feat-086 re-checked on the same build: S3 on a closed port → avatar upload 500, one `error` record with the `ECONNREFUSED` cause.
    - Test users deleted from the local database afterwards.
- Note for manual checks: `tsx src/index.ts` is not enough — `package.json` `imports` map `#app/*`, `#vendor/*` to `dist/*`, so build first. The `wsUrl` in auth responses comes from `APP_DOMAIN`, not `PORT`.
- Not run: a manual Redis outage over WS (would stop the shared local Redis; covered by the dispatcher test). `test:redis` / `test:pg` locally (no change in Redis/DB code; CI runs them).

## Unrelated finding

The local database lacks `user_online.role` (a migration is not applied locally): `user_online: failed to track connect` on every WS connect. Not caused by this branch.

## Next step

Review + merge, then "Mark feat-087 done". Next: stage 3a (cleanup without behaviour change).
