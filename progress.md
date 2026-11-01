# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-077 - Dead Code Backend (in progress, K1)
**Branch:** `chore/dead-code-backend`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase K1. H1 (feat-070) depends on it

## Status

### Done

- [x] Every item was checked before it was removed: no production reference outside its own definition (and its spec). **28 files, 27 insertions, 1121 deletions** under `packages/` (docs aside)
- [x] `vendor/utils/helpers`: `normalize-user-id.ts` (+ spec), the barrel `index.ts` (nobody imported it), `toCanonicalEntityId`, `isAuthorizedEntityRequest` and, with `normalizeUserId` gone, `isSessionUserId` / `SESSION_USER_ID_REGEX`; the commented copy of `normalizeUserId` in `redis-session-storage.ts`
- [x] `app/middlewares/test-middleware{,-2,-3,-4}.ts` and their `kernel.ts` entries (`test1`…`test4` were registered but no route used them)
- [x] `get-typed-payload.ts`: `getTypedQuery`, `isHttpContext`, `isWsContext` (only `getTypedPayload` is used); `session-access.ts` (`resolveActorAuth`, `resolveResourceOwnership`); `applyAppError` (the controllers use `applyAppErrorStatus` + `appErrorToHttpPayload`); `tryDomain` (+ its test); `app-error-samples.ts` moved into the two specs that used it; `staticIndexHandler` and the `indexData` it alone read
- [x] `vendor/types/types.d.ts`: `WsMiddleware`, `Validators`, `HttpHandler`, `WsHandler`, `HttpController`, `WsController`; `HandlerReturn` is no longer exported (still used by the handler type)
- [x] `app/validate/schemas/common/pagination.ts` (+ spec) and `query/arktype-inference.spec.ts` (tested local copies of schemas, and a re-export that only the spec imported)
- [x] Commented-out code in `index.ts`, `ws-context.ts`, `session-handler.ts`
- [x] Docs: `middlewares.md`, `validation.md`, `services.md`, `testing.md` no longer name what is gone

### Left out on purpose

- **`serialize-routes.ts` "speculative branches"** (plan: keep only `isArkType → serializeArkSchema`). The plan's line numbers (866-951) belong to an older file (now 176 lines), and the branches it points at are the `describe()` adapter contract of feat-041: a ready descriptor and plain JSON Schema, documented in `backend/validation.md` and covered by `serialize-routes.spec.ts`. Removing them would withdraw a documented extension point, which is a decision for the owner, not dead code
- Also removed, because it became unreferenced with the barrel: `vendor/utils/helpers/parse-user-agent.ts` (no importer in backend, frontend or shared)

## Evidence of Completion

| Check                                      | Result                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                                                            |
| `pnpm build`                               | exit 0                                                                                                            |
| `pnpm test`                                | backend 1659 (1685 − 26 tests that belonged to deleted code), frontend 257, api-playground 29, shared 17, docs 26 |
| `docs:build && docs:verify`                | passed                                                                                                            |

## Notes for Next Session

1. Merge this PR; then a PR flipping feat-077 to `done`
2. Next: H1 (feat-070, `enforceThrottle()`); its dependencies feat-060, feat-069, feat-077 are then done. The tables of G1 are the net
