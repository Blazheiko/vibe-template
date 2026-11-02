# Session Progress Log

## Current State

**Last Updated:** 2026-11-02
**Active Feature:** feat-084 - Small Dedup (review)
**Branch:** `refactor/small-dedup`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, H6 (the list had gone partly stale; what was real is below)

## Status

- [x] **`knowledge-base-service.ts`**: `requireArticle(id)` replaces five load-and-404 blocks (the plan said ×7; the sixth, `getScreenshotKey`, answers `null` for a missing article on purpose and stays) and `deleteScreenshotQuietly(key, message)` the three S3 deletes. The log line of the two that logged without the key now carries `key` too
- [x] **One error body for HTTP and WebSocket**: `appErrorToPayload` / `AppErrorPayload` in `services/shared/app-error-payload.ts` replace `appErrorToHttpPayload` and `appErrorToWsError` (identical bodies; a spec had pinned that). `ws-error.ts` is gone; the specs moved to `app-error-payload.spec.ts`
- [x] **`normalizePath`** (three copies in the backend: `config/app.ts`, `http-request-handlers.ts`) -> `vendor/utils/helpers/normalize-path.ts`; **`ab2str`** (`ws-handlers.ts`, `get-ip.ts`) -> `vendor/utils/helpers/ab2str.ts`; both with specs. The api-playground has its own `normalizePath`, left: the playground does not depend on the backend
- [x] **`oauth-service.ts`**: `fetchJson<T>` replaces `fetchJson` + `fetchJsonArray`
- [x] **`requireUserId(context)`** in `controllers/shared/require-user-id.ts` replaces the three local copies (avatar, push subscriptions, support) and the inline `getUserId()` checks of `auth-controller.ts` (the plan said 28 places; five in `auth-controller.ts`, one of them with the extra `check()`, and the three helpers were real). It asks `auth.check()` first, then the id. **One difference, unreachable in practice**: the four `auth-controller` handlers that asked `getUserId()` alone now also need `check()`, which differs only for an empty-string user id (answers 401 now, used to be user 0)
- [x] Not done, as the plan says "only with the team's consent": repository interfaces -> inference, a base `HttpError` class
- [x] Docs: `backend/controllers.md`, `backend/websocket.md`, `backend/adding-a-feature.md`

## Evidence of Completion

| Check                                      | Result                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                  |
| `pnpm build`                               | exit 0                                                                  |
| `pnpm test`                                | backend 1855 (+11), frontend 373, shared 25, api-playground 62, docs 26 |
| `pnpm --filter backend test:pg`            | 87 passed, 64 skipped                                                   |
| `docs:build && docs:verify`                | passed                                                                  |
