# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-070 - Auth Throttle Helper (in progress, H1)
**Branch:** `refactor/auth-enforce-throttle`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase H1

## Status

### Done

- [x] `app/services/auth/enforce-throttle.ts`: `enforceThrottle(policy, key, { unavailable, rejected }): Promise<AppResult<void>>`. It consumes one attempt through `consumeAuthThrottle` and answers `ok`, `rejected` (a spent counter) or an internal error carrying `unavailable` (503 when Redis is unreachable). The plan's signature had one message (`rejectMessage`); the sites differ in **two** things (the 500 text of a failed consume and the error of a spent counter, which is a 401 for login), so both are passed. It lives in its own file: the specs mock `auth-throttle-service.js` with `consumeAuthThrottle` and `resetAuthThrottle` only, and the helper must not need a new export from that mock
- [x] 20 steps moved to it, one commit per file: `emailVerificationService` 2, `passwordResetService` 4, `authService` 14 (register 2, phone registration 3, phone link 3, e-mail link 3, login 2, change password 1)
- [x] Left alone on purpose, they are not the same step: `requestPasswordReset` (two counters inside one `tryInternal`, never fails, answers the generic text) and `resendVerificationAfterUnverifiedLogin` (swallows everything, logs a warning)
- [x] **No expectation changed.** The G1 tables (`*throttle-contract.spec.ts`: scope, key, order, 500/503 texts, blocked answers) and every other auth spec pass untouched: 428 tests. Mutating the helper (no check of `allowed`, another key, another 500 text) fails 45, 35 and 22 of them
- [x] Docs: `backend/security.md` describes the step and its example uses it
- [x] Redis keys are the same by construction (the policy and the key are passed as before) and by the table (`scope`, `key` of every step)

## Evidence of Completion

| Check                                      | Result                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| Auth specs without any change              | 428 passed (18 files)                                                                 |
| Mutations of the helper                    | 45 / 35 / 22 failures                                                                 |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                                |
| `pnpm test`                                | backend 1663 (+4 for the helper), frontend 257, api-playground 29, shared 17, docs 26 |
| `docs:build && docs:verify`                | passed                                                                                |

## Notes for Next Session

1. Merge this PR; then a PR flipping feat-070 to `done`
2. Next: H2 (feat-071, `auth-normalize.ts`)
