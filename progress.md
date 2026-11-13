# feat-208: Push and Cleanup Lows

Step S14 of `docs/plan/security-review-2026-11-12-plan.md` (decision Д8). Findings L-10, I-3,
I-6, I-7, I-1 of `docs/security/security-review-2026-11-12.md`.

## Current State

Done, ready for review.

## What Changed

- **L-10.** `upsertSubscription` checks the length of the canonical endpoint (the form that is
  stored) against `PUSH_ENDPOINT_MAX_LENGTH` (500, new in `shared/limits`) and answers
  `400 push_endpoint_too_long`. Before, a non-ASCII path passed the schema, grew when
  percent-encoded and failed the INSERT with a 500.
- **I-3.** The transformer and the response schema of a push subscription no longer carry
  `p256dhKey`, `authKey` and `ipAddress` (create, list, read, update). The frontend and the API
  playground never read them.
- **I-6.** `dompurify` removed from `packages/frontend/package.json` (it stays in the lockfile as
  a dependency of the documentation's mermaid).
- **I-7.** `PASSWORD_MAX_LENGTH = 128`. The forms take the limit from `shared/limits`; the
  texts of the three locales named 32 as a number and now name 128, and a new spec ties the
  numbers in the texts to the constants.
- **I-1.** `documentation/backend/ai.md` (uk + en): the support system prompt and the active
  knowledge-base articles are visible to the user; no secrets in them. No code change.

## Files Modified

- `packages/shared/src/limits/index.ts`, `responses/push-subscription-controller.ts`,
  `test/contracts.test.js`
- `packages/backend/src/app/services/notifications/push-subscription-service.ts` (+ spec)
- `packages/backend/src/app/transformers/push-subscription-transformer.ts` (+ spec)
- `packages/backend/src/app/controllers/http/notifications/push-subscription-ownership.pg.test.ts`
- `packages/frontend/package.json`, `pnpm-lock.yaml`
- `packages/frontend/src/locales/{en,uk,pl}.ts`, `locales/__tests__/password-limits.spec.ts` (new)
- `packages/frontend/e2e/mock/register.spec.ts`, `e2e-live/registration.spec.ts`,
  `e2e-live/support.ts`
- `documentation/backend/{auth,web-push-notification,ai}.md` and the same pages under
  `documentation/en/backend/`

## Evidence of Completion

- `make check`: passed (backend 2969, frontend 583, api-playground 115).
- `pnpm --filter backend test:pg` with `PG_TEST_URL` and `REDIS_TEST_URL`: 33 files / 321 tests
  passed. `test:redis`: 117 passed.
- `pnpm docs:build && pnpm docs:verify`: passed.
- `pnpm --filter frontend test:e2e`: 95 passed. The first run had one failure in
  `e2e/mock/login.spec.ts:153` (a second click while the request is in flight), a test this
  change does not touch; it passed three times in a row alone and in the second whole run.
- Live e2e: 15 passed, with the new test: a password of 100 characters registers, confirms the
  address, signs in through the form, and the same password one character shorter is a 401.
- **Negative control.** With the source reverted and the tests kept: the PG test gets
  `expected 500 to be 400` for the Cyrillic endpoint (the finding, reproduced) and finds
  `p256dhKey` in the responses; the service and transformer specs fail (2); the locale spec
  fails for the three locales (3).
- **Manual check on the real stack** (production-like build, port 3100, a signed-in browser):
    - `POST /api/push-subscriptions` with `https://fcm.googleapis.com/` plus 400 Cyrillic letters:
      `400 {"code":"bad_request","reason":"push_endpoint_too_long"}`.
    - A created subscription and `GET /api/push-subscriptions` answer the endpoint, the device
      fields, ids and dates, and no `p256dhKey`, `authKey` or `ipAddress`.

## Notes

- The 100-character password is registered through the API and typed into the sign-in form;
  the registration form's own limit (129 characters refused on the client) is in the mock e2e.

## Next Step

Merge, mark `feat-208` done on `main`, then the closing step of the plan: the status table in
the security review.
