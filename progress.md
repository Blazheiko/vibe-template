# feat-109 — Reauth Throttle and Pending Tokens

Plan: `docs/plan/code-review-2026-11-03-plan.md`, item R06b (findings 7, 11; after feat-106). Branch: `fix/feat-109-reauth-throttle-pending-tokens` (from `main` after #360).

## Current State

Implemented; PR open.

- `requireCurrentPasswordReauth` (link-email/start, link-phone/start):
    - spends `throttlePolicies.changePasswordUser` for the user before `validatePassword`, and resets it after a right password;
    - this is one budget shared with change-password (`AUTH_CHANGE_PASSWORD_MAX_ATTEMPTS_PER_USER`, default 10 per 15 min), so the endpoints cannot be combined to get more guesses;
    - when spent, it answers `Too many password attempts. Please try again later.`
- `changePassword` and `logoutAll`:
    - the conditional rotation (`changePasswordIfCurrent` / `updateIfSessionToken`, both now with an executor) and `passwordResetRepository.invalidatePendingByUserId` run in one `withTransaction`;
    - no rotation (conflict or revoked) means nothing is retired, and a failure retiring the links rolls the rotation back.
- Email-verification tokens are left alone: they are not a credential reset.
- Docs: `documentation/backend/auth.md`, `configuration.md`.

## Files Modified

- `packages/backend/src/app/services/auth/auth-service.ts`, `src/app/repositories/user/user-repository.ts`
- Specs updated for the new throttle order and the transaction argument:
    - `auth-service.spec.ts`, `auth-service.contract.spec.ts`, `auth-service.regression.spec.ts`;
    - `auth-service.throttle-contract.spec.ts`: the link rows start with `change_password_user`, and there are new rows for `startPhoneLink · password` and `startEmailLink · password`.
- `packages/backend/src/vendor/utils/session/logout-all.redis.test.ts` (fake `withTransaction` and reset repository, no DB in that suite)
- New: `packages/backend/src/app/services/auth/reauth-and-reset-links.pg.test.ts`
- `documentation/backend/auth.md`, `documentation/backend/configuration.md`

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 2266, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` with `REDIS_TEST_URL` locally: 24 files / 218 passed, nothing skipped.
- `test:redis`: 9 files / 91 passed.
- `reauth-and-reset-links.pg.test.ts` (real PostgreSQL and Redis), 8 cases:
    - 10 wrong re-checks, then the right password → `Too many password attempts`;
    - change-password after 10 wrong re-checks → refused, password unchanged;
    - a right password resets the budget;
    - change-password / logout-all retire a pending reset link;
    - an injected failure retiring them leaves password and token unchanged;
    - a revoked session retires nothing.
- Mutation check: with `main`'s `auth-service.ts`, 6 of the 8 cases fail. The budget-reset and revoked-session cases are guards.
- Manual: the PG suite drives the real service on PostgreSQL + Redis. The link mail is mocked.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next by the plan order: R07 (client IP keys). Owner decision Д3 (IPv6 /64) is still open; Д5 (explicit unix-socket proxy flag) is taken.
