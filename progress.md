# feat-103 — SMS Attempt Atomicity

Plan: `docs/plan/code-review-2026-11-03-plan.md`, item R02. Branch: `fix/feat-103-sms-attempt-atomicity` (from `main` at `3d62d8e`).

## Current State

Implemented; PR open.

- `sms-auth-challenge-repository.ts`:
    - `incrementAttemptCount` replaced by `consumeAttempt(id, max, executor?)`: one `UPDATE … SET attempt_count = attempt_count + 1 WHERE id AND confirmed_at IS NULL AND invalidated_at IS NULL AND expires_at > now AND attempt_count < max RETURNING *`.
    - New `markInvalidatedIfPending(id, executor?)` (`confirmed_at IS NULL AND invalidated_at IS NULL`); `markInvalidated` keeps its unconditional meaning (registration retires a confirmed challenge with it).
    - `markConfirmed` takes an executor.
- `sms-challenge.ts` `verifySmsCode(challenge, code, { noLongerValid }, executor?)`:
    - spends a try before every comparison (the right code too) and compares with the hash of the returned row;
    - no row → `noLongerValid` without a comparison;
    - a wrong code on the last try → `markInvalidatedIfPending`.
    - `confirmChallenge` takes an executor (prerequisite for R06a).
- The three flows pass their "… no longer valid" answer.
- Docs: `documentation/backend/auth.md` (SMS paragraph), `configuration.md` (`AUTH_SMS_MAX_INVALID_ATTEMPTS` counts every check).

Behaviour change: `AUTH_SMS_MAX_INVALID_ATTEMPTS` now bounds checks, not only wrong ones. A user who typed max-1 wrong codes and then the right one still passes; after the right code, a later retry of the same confirm (e.g. after a phone conflict) can find no try left and must restart.

## Files Modified

- `packages/backend/src/app/repositories/auth/sms-auth-challenge-repository.ts`
- `packages/backend/src/app/services/auth/sms-challenge.ts`, `auth-service.ts`, `password-reset-service.ts`
- Specs: `sms-challenge.spec.ts` (verify cases rewritten), `auth-phone-foundation.spec.ts`, `auth-service.contract.spec.ts`, `auth-service.throttle-contract.spec.ts`, `password-reset-service.contract.spec.ts`, `password-reset-service.throttle-contract.spec.ts`, `password-reset-service.spec.ts` (mock renamed; default `consumeAttempt` spends a try on the `findById` row)
- New: `packages/backend/src/app/services/auth/sms-attempt-race.pg.test.ts`
- `documentation/backend/auth.md`, `documentation/backend/configuration.md`

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 2173, frontend 400, api-playground 62 passed.
- `pnpm --filter backend test:pg` locally: 16 files / 121 tests passed, 5 files skipped by their own conditions; `sms-attempt-race.pg.test.ts` ran 7 passed. Full run: CI `test-pg`.
- `pnpm docs:build && pnpm docs:verify` passed.
- `sms-attempt-race.pg.test.ts` (real PostgreSQL, budget 3, 10 parallel requests):
    - 10 wrong codes on one stale row → exactly 3 comparisons, 3 × "Invalid verification code", 7 × no-longer-valid, `attempt_count = 3`, invalidated;
    - two right codes → one confirmation;
    - wrong code spending the last try held between its try and its invalidation while the right code confirms → stays confirmed, not invalidated;
    - wrong code on a confirmed challenge → not compared, nothing changes;
    - through `confirmPhoneRegistration`, `confirmPhoneLink`, `completePhonePasswordReset`, with a barrier holding all 10 requests after `findById` → 3 comparisons, invalidated, not confirmed.
- Mutation check: against `main`'s `sms-challenge.ts`, repository and callers, 6 of the 7 cases fail. The two-right-codes case passes on `main` too, because `markConfirmed` already guaranteed it; it stays as a regression test.
- Manual: the PG suite drives the three real service flows against PostgreSQL. No HTTP-level run, because the SMS provider is a fake in this template.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next: R03 (push endpoint SSRF). Owner decision Д1 is taken: allowlist of hosts. Д2, Д5, Д6 are taken as recommended; Д3 and Д4 are still open.
