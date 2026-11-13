# feat-214: SMS Budget Of Refused Register And Link Starts

Plan: `docs/plan/security-review-2026-11-12-follow-ups-plan.md`, F02 (follow-ups item 8).

## Current State

Done, ready for review.

## The Gap

`startPhoneRegistration` (`register/phone/start`) and `startPhoneLink` (`link-phone/start`)
spent the hourly SMS budget of the number (`smsSendPhone`) before `issueSmsChallenge` checked
the resend cooldown under the advisory lock. A start the cooldown refused, one after another
or in a parallel burst, had paid all the same: anyone could use up the budget of somebody
else's number without one SMS being sent, and the owner could not register or link it for an
hour. feat-212 fixed the same order for the phone reset only.

## What Changed

- `openChallenge` takes `spendBudget`, called under the lock after the cooldown check and before
  anything is retired or created; an error from it opens nothing and is the answer.
  `issueSmsChallenge` requires it and passes it on (its only callers are these two flows).
- `auth-service.ts`: both flows pass `spendSmsBudget(phone)` instead of spending `smsSendPhone`
  before the lookups. `registerPhoneIp`, `linkPhoneIp` and `linkPhoneUser` stay before the lock
  (they limit the sender; `linkPhoneUser` guards the "number taken" answer, feat-117).
- Throttle contract spec: the `· phone` rows of both flows are marked `underLock` (the number
  lookups ran before the budget); nothing is retired, stored or sent.
- Docs uk + en: `backend/auth` (accepted-risk note and the link-phone limits list).
- `docs/security/security-review-2026-11-12-follow-ups.md`: item 8 marked fixed.

## Files Modified

- `packages/backend/src/app/services/auth/sms-challenge.ts`, `auth-service.ts`
- `packages/backend/src/app/services/auth/register-link-phone-sms-budget.pg.test.ts` (new)
- `packages/backend/src/app/services/auth/sms-challenge.spec.ts`
- `packages/backend/src/app/services/auth/auth-service.throttle-contract.spec.ts`
- `documentation/backend/auth.md`, `documentation/en/backend/auth.md`
- `docs/security/security-review-2026-11-12-follow-ups.md`

## Evidence of Completion

- `make check`: passed (backend 2981, frontend 607, api-playground 115).
- `pnpm --filter backend test:pg` with `PG_TEST_URL` and `REDIS_TEST_URL`: 35 files / 331 tests
  passed. `test:redis`: 117 passed. `docs:build` + `docs:verify`: passed.
- **RED first.** The new PG test against the code before the fix, for both flows:
  `expected 8 to be 1` (budget spent by a burst of 8 parallel starts) and `expected 2 to be 1`
  (a second start refused by the cooldown). After the fix: 1 and 1.
- **Manual check on the real stack** (`node dist/index.js` on port 3101, phone auth on with the
  fake SMS provider, `AUTH_SMS_MAX_SENDS_PER_PHONE_PER_HOUR=3`): 8 sessions (each from
  `GET /api/main/init`) send `POST /api/auth/register/phone/start` for one number at once: one
  `200` with a challenge, seven `429`. The Redis counter `auth:throttle:sms_send_phone:<number>`
  is `1`. A second burst during the cooldown: `429 resend_cooldown_active` (and
  `rate_limit_exceeded` once the per-IP budget of 10 was used), counter still `1`.
  `link-phone/start` is covered by the PG test (8 accounts, one number).

## Next Step

Merge, then mark `feat-214` done on `main`; next feature of the plan: feat-213.
