# Progress: feat-100 Registration Race Unique Violation

Branch: `fix/feat-100-register-race`. Plan: `docs/plan/register-race-plan.md`. Start PR #333 (merge 18c783b).

## State

- Steps 0–6 of the plan done; feature PR open, waiting for CI.
- Next: merge after green checks, then the "Mark feat-100 done" PR (flip to `done`, evidence, delete this file).

## Problem

Two concurrent registrations with one email (or phone completions / phone links with one number) both passed the lookup; the second write hit the unique index (`users_email_unique_non_null_idx` on `LOWER(email)`, `users.phone`) and the uncaught error answered 500 `internal_error`.

## Change

- `auth-service.ts` `persistRegisteredUser`: `isUniqueViolation` around `userRepository.create` returns the `REGISTRATION_TAKEN` sentinel (compared by reference) before the verification mail, the challenge invalidation, the session destroy and the login. Any `23505` is read as a lost race (documented assumption in the comment: a registration fills only one of email/phone, `session_token` is a random nanoid).
- `registerEmailFlow`: the sentinel answers the generic registration message in both modes; non-strict loser neither logs in nor destroys its session.
- `completePhoneRegistration`: the sentinel answers `409 Phone already exist` (same as the lookup).
- `confirmPhoneLink`: `isUniqueViolation` around `updateIfSessionToken` answers `409 Phone is already linked to another account`; the challenge stays confirmed (known trade-off, separate task if ever needed).
- `src/test-support/race-barrier.ts`: `bothReadBeforeEitherWrites` moved out of `one-time-token-race.pg.test.ts` and shared.
- Docs: `documentation/backend/auth.md`, registration section.

## Files modified

- `packages/backend/src/app/services/auth/auth-service.ts`
- `packages/backend/src/app/services/auth/auth-service.regression.spec.ts` (+6 unit tests)
- `packages/backend/src/app/services/auth/auth-phone-foundation.spec.ts` (+3 unit tests)
- `packages/backend/src/app/services/auth/register-race.pg.test.ts` (new, 4 pg tests)
- `packages/backend/src/app/services/auth/one-time-token-race.pg.test.ts` (uses the shared barrier)
- `packages/backend/src/test-support/race-barrier.ts` (new)
- `documentation/backend/auth.md`
- `progress.md` (this file)

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: clean.
- `pnpm test`: backend 2141 (+9) / frontend 400 / api-playground 62 / shared 25 / documentation 26.
- `pnpm --filter backend test:pg` (local PostgreSQL): 112 passed, 70 skipped (suites needing other services; CI runs them); `register-race.pg.test.ts` 4/4: strict both generic + one row + one session destroyed; non-strict one signed in, loser generic without login/destroy; phone completion one user, loser 409, its challenge not invalidated; phone link with two accounts and two challenges, one owner, loser 409 and phone unchanged.
- Barrier: each pg test holds both requests after the lookup (`findByEmail`, `findByPhone`, `phoneExistsForOtherUser`) until both have read, so the second write meets the index.
- Mutation checks: old `auth-service.ts` fails all 4 pg tests and 6 unit tests; dropping only the non-strict mapping fails exactly the 2 non-strict unit tests and the non-strict pg test.
- `pnpm docs:build && pnpm docs:verify`: passed.
- Manual on `dist` (PORT=3077, 3 pairs of concurrent `curl` per run, same email in a pair): old code — one pair answered `500 internal_error` + 200 with one row; new code strict — all 200 generic, one row per email; new code non-strict — per pair one 200 with user and one 200 generic, one row per email. Test users deleted, `register_email_ip` throttle keys reset.
