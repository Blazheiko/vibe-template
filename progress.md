# feat-204: Phone Reset Hardening

Plan: `docs/plan/security-review-2026-11-12-plan.md`, S10. Findings: L-3, L-4 of
`docs/security/security-review-2026-11-12.md`. Decision Д6. Branch:
`fix/phone-reset-hardening`.

## Current State

Done, in review.

- **L-3 (Д6).** A phone reset challenge belongs to a browser session. A start from another
  session opens a challenge of its own next to the one that is waiting (`openSessionChallenge`)
  instead of getting the generic answer with no challenge. A start retires only the challenges
  of its own session and expired leftovers, so nobody cancels a reset they did not start
  (feat-160 stays). At most two live reset challenges per number; a third session gets the
  generic answer, sends nothing and spends no SMS budget. The resend cooldown stays per number.
- **L-3, accepted risk.** The hourly SMS budget of a number can still be spent by anyone who
  knows the number. Recorded in `documentation/backend/auth.md` and in `config/auth.ts`.
- **L-4a.** Every code tried against one number in `reset-phone/complete` spends a daily budget
  (`resetPhoneCodeAttemptsPhone`, 10 per day, `AUTH_RESET_PHONE_MAX_CODE_ATTEMPTS_PER_DAY`)
  that a new challenge does not renew; a completed reset clears it. The other side, documented:
  ten wrong codes from a third party block the reset for that number until the day ends.
- **L-4b.** The SMS is sent after the answer, like the reset mail. A failed send no longer
  changes the answer: the challenge is invalidated and the failure is logged.
- The other SMS flows (phone registration, phone linking) still use `openChallenge` and are
  unchanged.

## Files Modified

- `packages/backend/src/app/services/auth/password-reset-service.ts`, `sms-challenge.ts`
- `packages/backend/src/app/repositories/auth/sms-auth-challenge-repository.ts`
- `packages/backend/src/config/throttle-policies.ts`, `config/auth.ts`, `.env.example`
- tests: `reset-phone-session-challenges.pg.test.ts` (new),
  `password-reset-service.contract.spec.ts`, `password-reset-service.spec.ts`,
  `password-reset-service.throttle-contract.spec.ts`, `throttle-policies.spec.ts`
- docs uk+en: `backend/auth.md`, `backend/security.md`, `backend/configuration.md`

## Evidence of Completion

- `make check`: passing (backend 2940, frontend 558, playground 115).
- `pnpm docs:build && pnpm docs:verify`: passing.
- `pnpm --filter backend test:pg` (33 files, 319 passed) and `test:redis` (11 files, 117
  passed) on real services. `reset-phone-session-challenges.pg.test.ts` on a real PostgreSQL:
  a second session opens its own challenge and the first stays; a third opens nothing; a
  session that starts again replaces only its own; an expired leftover is retired and does not
  count; three sessions starting at once leave two live challenges.
- RED: with `password-reset-service.ts` as on `main`, 15 cases of the two specs fail.
- Manual, on the real stack with the fake SMS provider (a temporary Playwright config and spec,
  not committed): a phone-only account was registered; an "attacker" session started a reset
  and got a challenge; the owner's session then got a challenge of its own (before this change
  it got none); a third session got the generic answer without a challenge; a wrong code
  answered 400; the owner completed the reset with their own challenge; the attacker's
  challenge was dead afterwards (400); sign-in with the new password worked.
- Whole `e2e-live` suite: 14 passed.
- Not measured: the response time of the start for a known and an unknown number. The answer
  no longer awaits the provider call, which is what made them differ.

## Notes for Next Session

Open lows: feat-205 (Sentry replay), feat-206 (HTTP core and cookie), feat-207 (supply chain),
feat-208 (push and cleanup).
