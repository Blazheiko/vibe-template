# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-078 - Dead Code Shared (in progress, K2)
**Branch:** `chore/dead-code-shared`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase K2

## Status

### Done

- [x] Removed `schemas/auth/register.ts` (`RegisterInputSchema`, a copy of `register-email.ts`) and `schemas/activity/` (`UserActivity*`): no importer in backend, frontend, api-playground or the shared tests; both exports gone from `schemas/index.ts`
- [x] `schemas/query/common.ts`: `PaginationQuerySchema`, `DateRangeQuerySchema`, `CursorQuerySchema` (+ their output types, `CursorFields`, `CursorQueryInput`) are gone and no longer exported; what the admin and usage queries use (`PaginationFields`, `DateRangeFields`, the `*Input` types, the three parse helpers) stays. The backend wrapper and spec that were their only users went in K1
- [x] `errors/error-codes.ts`: `ErrorCodeValues` is `Object.values(ErrorCode)` typed `readonly ErrorCode[]`, so it cannot drift from `ErrorCode`; `ErrorCodeSchema` (`type.enumerated(...)`) still infers the union (typecheck of all packages clean). The hand-synced `CSRF_REJECT_REASONS` had no user but its own sync test and is gone
- [x] `shared/test/contracts.test.js`: the two sync tests (nothing left to sync) are replaced by a test that `ErrorCodeSchema` accepts every `ErrorCode` and nothing else (5 invalid inputs), and one that the `CsrfRejectReason` values are distinct snake_case words
- [x] `brands/` stays (the plan keeps it for phase I)
- [x] Docs: `backend/validation.md` example now shows `register-email.ts`
- [x] Verified from a clean `dist` (stale compiled files of the removed modules cannot hide a missing import)

## Evidence of Completion

| Check                                      | Result                                                            |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check` | exit 0 (from a clean shared `dist`)                               |
| `pnpm build`                               | exit 0                                                            |
| `pnpm test`                                | shared 17, backend 1731, frontend 257, api-playground 29, docs 26 |
| `docs:build && docs:verify`                | passed                                                            |

## Notes for Next Session

1. Merge this PR; then a PR flipping feat-078 to `done` and starting feat-079 (K3)
2. K3 needs a decision: whether `browserName` / `osName` / `deviceType` of a push subscription are used by the backend or the admin views (check before removing the UA parsing in `stores/state.ts`)
