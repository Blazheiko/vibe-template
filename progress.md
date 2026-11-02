# feat-088 — Backend Error Path Cleanup

Plan: `docs/plan/error-handling-fix-plan.md`, stage 3 (3a + 3b).

## Current state

Implemented, awaiting review. Start PR #296 merged (feat-088 → `in_progress` on `main`).

## 3a — no behaviour change

- `server.ts`: one `#config/app.js` import (`appConfig`) instead of `appConfig` + `configApp`; `getResponseData` alias removed; commented-out code removed; the Russian comment on the synchronous rate-limit step translated; `docRoutesHandler` is synchronous (no `new Promise`).
- Typed middlewares instead of `context as unknown as HttpContext`: `Middleware<TContext>`; `kernel.ts` has `httpMiddlewares` and `wsMiddlewares`; `execute-httpMiddlewares.ts` exports `executeMiddlewares` (HTTP, default) and `executeWsMiddlewares`; `ws-admin-guard` takes a `WsContext` and answers through `mapWsControllerError` (same 403 body). A route naming a middleware of the other transport now fails as `No middleware <name>` instead of running with the wrong context.

## 3b — log stream change (listed for review)

| Removed record                                                                                                                      | Who logs the same event now                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `session-handler` `Login error:` / `Logout error` / `LogoutAll error` (error, then rethrow)                                         | the service turns the throw into an `AppError` (`tryInternal`); the controller logs it once via `reportAppError` (feat-086) |
| `logger.info('<method> handler')` and similar name-only lines in `main`, `auth`, `avatar`, `oauth`, `push-subscription` controllers | nothing needed: route and `requestId` are in the request logger context                                                     |

Kept: `oauth generated URL` and the detailed OAuth callback log (they carry data).

Found while doing it: the OAuth callback answers errors with a redirect (`redirectToError`), not `mapControllerError`, so after feat-086 a 5xx there still had no record with its cause; only the log-and-rethrow in `auth.login` covered part of it. Added `reportControllerError` (controller-error.ts) and `redirectToError` calls it.

## Files modified

- `packages/backend/src/vendor/start/server.ts`, `src/vendor/utils/routing/ws-api-dispatcher.ts`, `src/vendor/utils/middlewares/core/execute-httpMiddlewares.ts`, `src/vendor/types/types.d.ts`, `src/app/middlewares/{kernel,ws-admin-guard}.ts`
- `packages/backend/src/vendor/utils/session/session-handler.ts`
- `packages/backend/src/app/controllers/shared/controller-error.ts`, `src/app/controllers/http/{core/main,auth/auth,auth/oauth,user/avatar,notifications/push-subscription}-controller.ts`
- Tests: `session-before-send.spec.ts` (auth methods reject without a log record), `oauth-controller.spec.ts` (5xx logged with cause, 4xx not), `ws-admin-guard.spec.ts`, dispatcher mocks in `ws-validation.spec.ts` / `ws-error-envelope.spec.ts`
- Docs: `documentation/backend/{middlewares,observability,controllers}.md`; plan stage 3 notes

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 1915, frontend 373, api-playground 62, shared 25, documentation 26 passed.
- `test:redis` 89, `test:pg` 152 (local; they run the middleware executor).
- `pnpm docs:build && pnpm docs:verify` passed.
- Mutation: with the old `session-handler.ts` (log-and-rethrow) the 3 new session tests fail.
- Manual on a fresh `dist` build (:3099): `GET /api/doc/routes` → 200 with 12 HTTP / 2 WS routes; a non-admin WS `api/admin/subscribe_online_users` → `status "403"`, `data: { code: 'forbidden', message: 'Access denied' }` (unchanged); no `... handler` info lines in the log. Test user deleted afterwards.

## Next step

Review + merge, then "Mark feat-088 done". Next: stage 7 (compat code) or stage 4 (`Result` only for expected outcomes, needs ADR 0004).
