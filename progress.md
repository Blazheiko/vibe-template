# feat-211: URL Token Path Variants And Verify-Email Password Limit

Follow-up to feat-205 and feat-208 (security review 2026-11-12, L-17 and I-7), found by a
review of `main` @ `76c18a7`.

## Current State

Done, ready for review.

## The Gaps

- **L-17.** `one-time-url-token.ts` compared the path with the exact spelling of the route.
  Vue Router also opens the page for `/reset-password/` and `/Reset-Password`; for those the
  token stayed in the address and reached Sentry Session Replay.
- **I-7.** The password field of `VerifyEmailView.vue` kept `maxlength="32"` after
  `PASSWORD_MAX_LENGTH` became 128.
- Found while checking on the real stack: `App.vue` compared the path with its list of public
  paths by the exact spelling too, so a signed-out visitor who opened `/Reset-Password/` was
  sent to `/login` instead of the form.

## What Changed

- New `utils/route-path.ts`: `normalizeRoutePath` (percent-decoding, lower case, no trailing
  slashes), the form the router compares. `one-time-url-token.ts` and the public-path check
  of `App.vue` compare it.
- `VerifyEmailView.vue`: `:maxlength="PASSWORD_MAX_LENGTH"`.
- Docs uk + en: `backend/observability`.

## Files Modified

- `packages/frontend/src/utils/route-path.ts` (new, + spec), `one-time-url-token.ts` (+ spec)
- `packages/frontend/src/App.vue`, `src/views/VerifyEmailView.vue` (+ spec)
- `packages/frontend/e2e/sentry/replay-url-token.spec.ts`, `e2e-live/registration.spec.ts`
- `documentation/backend/observability.md`, `documentation/en/backend/observability.md`

## Evidence of Completion

- `make check`: passed (backend 2978, frontend 607, api-playground 115).
- `pnpm --filter frontend test:e2e`: 99 passed, with the Playwright `sentry` project (the real
  SDK with replay on): 7 passed, four of them new (a trailing slash, another case, both, a
  percent-encoded spelling).
- Live e2e: 16 passed, with the new test: a verification link opened as `/Verify-Email/` by a
  signed-out browser shows no token in the address, its password field takes 100 characters,
  and the address is confirmed.
- `pnpm docs:build && pnpm docs:verify`: passed.
- **Negative control.** With `one-time-url-token.ts` and `VerifyEmailView.vue` reverted: the
  four new `sentry` tests fail (the token is in the address and in the envelope), and 17 unit
  tests fail (the spellings in `stripUrlTokenFromLocation` and the router guard, the
  `maxlength` of the field).
- **Manual check on the real stack** (production-like build, port 3100): a password reset
  link from a real mail, opened as `/Reset-Password/`: the form is shown, the address is
  `http://localhost:3100/Reset-Password/` without the token, a new 100-character password is
  saved and signs in. Before the `App.vue` change the same address ended on `/login`.

## Notes

- The router does not open the page for a percent-encoded spelling (`/reset%2Dpassword`); the
  visitor gets "not found". The token still leaves the address; a `sentry` test covers it.
- The backend has no part in this: it serves the SPA shell for every spelling.

## Next Step

Merge, mark `feat-211` done on `main`, then `feat-212`.
