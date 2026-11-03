# feat-106 — Phone Reset Transaction

Plan: `docs/plan/code-review-2026-11-03-plan.md`, item R06a (after feat-103). Branch: `fix/feat-106-phone-reset-transaction` (from `main` at `b9be160`).

## Current State

Implemented; PR open.

- `services/shared/transaction-result.ts` (new) `withTransactionResult(work)`: commits on `Result.ok` and rolls back on `Result.err` or a throw, returning the error. `withTransaction` alone commits whatever the work returns.
- `password-reset-service.ts` `completePhonePasswordReset`:
    - before the transaction: verify the code (the spent try commits on its own) and hash the new password (so the lock is not held during hashing);
    - in `withTransactionResult`:
        - `userRepository.lockById`;
        - re-check `email IS NULL` and the phone on the locked row;
        - `confirmChallenge(…, tx)`, `invalidatePendingPhoneChallenges(phone, tx)`, `passwordResetRepository.invalidatePendingByUserId(user.id, tx)`;
        - `userRepository.update(…, tx)` with the new password and session token;
    - after commit: session cleanup and the security notice, as before.
- Docs: `documentation/backend/auth.md`.

## Files Modified

- `packages/backend/src/app/services/shared/transaction-result.ts` (new) + spec
- `packages/backend/src/app/services/auth/password-reset-service.ts`
- `packages/backend/src/app/services/auth/password-reset-service.spec.ts`, `password-reset-service.contract.spec.ts` (phone rows read the user via `lockById`, expect `TX`)
- `packages/backend/src/app/services/auth/phone-reset-transaction.pg.test.ts` (new)
- `documentation/backend/auth.md`

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 2235, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` locally: 17 files / 136 tests passed, 5 files skipped by their own conditions.
- `phone-reset-transaction.pg.test.ts` (real PostgreSQL), 8 cases:
    - ok;
    - a wrong code keeps its spent try;
    - a concurrent email link holding the user row lock → the reset waits, then refuses, nothing confirmed;
    - a throw in the update → confirmation rolled back, and a retry with the same code succeeds (`attempt_count` 2);
    - an update returning nothing (`Result.err`) → rolled back;
    - a failure retiring the reset links → password and session token unchanged;
    - pending email reset links are retired;
    - two parallel completions → one reset.
- Mutation check: with `main`'s `password-reset-service.ts`, 5 of the 8 cases fail. The ok, wrong-code and parallel cases already held on `main`.
- Manual: the PG suite drives the real service on PostgreSQL. The SMS provider is a fake in this template, so there is no HTTP-level manual run.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next by the plan order (wave 2): R04 (WS registry lifecycle), then R05 (mail escaping and OAuth fetch).
