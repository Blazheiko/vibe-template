# feat-212: SMS Budget Of A Refused Parallel Reset Start

Follow-up to feat-204 (security review 2026-11-12, L-3), found by a review of `main` @
`76c18a7` by reading the code.

## Current State

Done, ready for review.

## The Gap

`startPhonePasswordReset` spent the hourly SMS budget of the number (`smsSendPhone`) after a
cooldown and capacity check made outside the advisory lock; `openSessionChallenge` checked
them again under the lock. Every start of a parallel burst passed the first check and spent
the budget, though the lock let one of them open a challenge. A burst could use up the budget
of somebody else's number at once, and the owner could not reset the password for an hour.

Reproduced before the fix on real PostgreSQL: 8 parallel starts, 1 challenge, 8 units spent.

## What Changed

- `openSessionChallenge` takes `spendBudget`, called under the lock after the cooldown and the
  capacity were checked and before anything is retired or created. An error from it opens
  nothing and is the answer.
- `startPhonePasswordReset` passes the `smsSendPhone` throttle as `spendBudget` instead of
  spending it before the lock. The account lookup now comes before the budget.
- Docs uk + en: `backend/auth`.
- `docs/security/security-review-2026-11-12-follow-ups.md`: item 8, the same order in the
  register and link phone starts, which this feature does not change.

## Files Modified

- `packages/backend/src/app/services/auth/sms-challenge.ts`, `password-reset-service.ts`
- `packages/backend/src/app/services/auth/reset-phone-sms-budget.pg.test.ts` (new)
- `packages/backend/src/app/services/auth/password-reset-service.throttle-contract.spec.ts`
- `documentation/backend/auth.md`, `documentation/en/backend/auth.md`
- `docs/security/security-review-2026-11-12-follow-ups.md`

## Evidence of Completion

- `make check`: passed (backend 2978, frontend 607, api-playground 115).
- `pnpm --filter backend test:pg` with `PG_TEST_URL` and `REDIS_TEST_URL`: 34 files / 325 tests
  passed. `test:redis`: 117 passed. Live e2e: 16 passed. `docs:build` + `docs:verify`: passed.
- **RED first.** The new PG test against the code before the fix: `expected 8 to be 1` for
  the budget spent by a burst of 8 parallel starts. After the fix: 1.
- **Manual check on the real stack** (production-like build, port 3101, phone auth on with
  the fake SMS provider, `AUTH_SMS_MAX_SENDS_PER_PHONE_PER_HOUR=3`): 8 browser sessions send
  `POST /api/auth/reset-phone/start` for one number at once. Answers: one `200` with a
  challenge, seven `429 resend_cooldown_active`. The Redis counter
  `auth:throttle:sms_send_phone:<number>` is `1`. With the old order it would have been 8,
  over the limit of 3.

## Notes

- The throttle contract spec changed for this route: when the SMS budget is spent, the account
  lookup has already run (it precedes the lock); nothing is stored or sent, as before.
- A Redis failure of the budget now happens inside the transaction: it rejects, the
  transaction rolls back, and the transport answers 503, as the contract spec checks.
- The register and link phone starts spend the same budget before their cooldown check. That
  is older behaviour outside this feature; it is recorded for the owner (follow-ups, item 8).

## Next Step

Merge, mark `feat-212` done on `main`, set M-1, L-3, L-17 and I-7 to "fixed" in the status
table of the security review.
