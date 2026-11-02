# feat-091 — Result For Expected Outcomes (3/3)

Plan: `docs/plan/error-handling-fix-plan.md`, stage 4, PR 3 of 3. ADR: `docs/adr/0004-result-for-expected-outcomes.md`.

## Current state

Implemented, awaiting review. Start PR #302 merged (feat-090 → done, feat-091 → `in_progress`). Stage 4 is complete: no `tryInternal` left; `result-helpers.ts` deleted.

## Changes

- `auth-service`: 33 `tryInternal` calls removed. Password hashing without the `createPasswordHash` wrapper; best-effort throttle resets (`resetThrottleQuietly`) and the old-session cleanup after a password change are explicit `try/catch` with `warn`.
- `enforceThrottle(policy, key, rejected)`: the `unavailable` 500 text is gone (a Redis failure throws; the transport answers 503). 20 call sites in auth, email-verification and password-reset services rewritten.
- `AuthController.changePassword`: a thrown session renewal is caught like a returned error; the done password change answers success with `sessionRenewed: false`, never a 500.
- `tryInternal`, `toInternalError` and their spec removed; `reportAppError` tests build `AppError`s directly.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 1916, frontend 373, api-playground 62, shared 25, documentation 26 passed.
- `test:redis` 89, `test:pg` 153 (local; session revocation and logoutAll retry over real Redis/PostgreSQL included).
- `pnpm docs:build && pnpm docs:verify` passed.
- Tests: fail-closed throttle tests (3 throttle-contract specs, phone foundation, regression, reset/verification) now check that the call rejects and nothing downstream ran; parametrised "budget spent / Redis fails" cases accept both refusals; Redis-outage cases check `classifyError` → 503 + `Retry-After`. New: the renewal-throws case in `changePassword` (fails without the catch).
- Manual on a fresh `dist` build: register → logout → login with a wrong password (401 `unauthorized`) → login → change password (200, `sessionRenewed: true`) → logout-all (200, `deletedCount: 1`) → login with the new password (200); no `error` records. Test user deleted afterwards.

## Files modified

- `packages/backend/src/app/services/auth/{auth-service,enforce-throttle,email-verification-service,password-reset-service}.ts`, `controllers/http/auth/auth-controller.ts`; `services/shared/result-helpers.ts` (+ spec) deleted
- Tests: auth specs listed above, `enforce-throttle.spec.ts`, `report-app-error.spec.ts`, `auth-controller.change-password.spec.ts`, `session-revocation.pg.test.ts`, `logout-all-retry.redis.test.ts`
- Docs: `documentation/backend/{services,controllers,request-lifecycle,observability}.md`; plan stage 4 notes

## Next step

Review + merge, then "Mark feat-091 done". Remaining plan stages: 5 (controller helper), 6 (session state class), 7 (compat code).
