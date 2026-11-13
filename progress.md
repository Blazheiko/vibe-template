# feat-205: Sentry Replay Without URL Tokens

Plan: `docs/plan/security-review-2026-11-12-plan.md`, S11. Finding: L-17 of
`docs/security/security-review-2026-11-12.md`. Branch: `fix/sentry-replay-url-tokens`.

## Current State

Done, in review.

- What the review proposed, masking in `beforeAddRecordingEvent` and an event processor, is not
  enough on its own: the replay records the page address in events of the DOM recorder, and
  the SDK passes only the integration's own events to `beforeAddRecordingEvent`. The control
  test shows a token left in the address reaching the replay with both hooks in place.
- So the token of a mailed link leaves the address before Sentry starts.
  `strip-url-token.ts` is the first import of `main.ts`: for `/reset-password`,
  `/verify-email` and `/oauth/link/confirm` it moves `?token=` to sessionStorage and cleans the
  address with `history.replaceState`, before the router is created. A router guard
  (`redirectWithoutUrlToken`) does the same for a navigation inside the application.
- The three pages read the token with `readUrlToken` and erase it after a successful use. It
  survives a reload of the page (the plan accepted an error on reload; sessionStorage avoids
  it).
- Second line: `beforeAddRecordingEvent` masks URLs in the replay's own events, and an event
  processor masks `urls` and `request.url` of a `replay_event`.
- A new Playwright project, `sentry`, with a build that has replay on: the real SDK in a real
  browser, envelopes intercepted and inflated.

## Files Modified

- `packages/frontend/src/utils/one-time-url-token.ts`, `strip-url-token.ts` (new)
- `packages/frontend/src/main.ts`, `router/index.ts`, `utils/sentry-service.ts`
- `packages/frontend/src/views/ResetPasswordView.vue`, `VerifyEmailView.vue`,
  `OAuthLinkConfirmView.vue`
- tests: `utils/__tests__/one-time-url-token.spec.ts` (new), `sentry-service.spec.ts`,
  `views/__tests__/VerifyEmailView.spec.ts`, `OAuthLinkConfirmView.spec.ts`,
  `e2e/sentry/replay-url-token.spec.ts` (new), `e2e/mock/unauthorized.spec.ts`
- `packages/frontend/playwright.config.ts` (project `sentry`), ignore files for
  `dist-e2e-sentry`
- docs uk+en: `backend/observability.md`, `backend/testing.md`

## Evidence of Completion

- `make check`: passing (backend 2940, frontend 577, playground 115).
- `pnpm docs:build && pnpm docs:verify`: passing.
- Real SDK, real browser (`playwright test --project=sentry`, 3 passed): a page opened from
  `/reset-password?token=<canary>&lang=uk` shows `/reset-password?lang=uk` at once; the replay
  envelopes mention `reset-password` and none contains the canary; the reset form is shown;
  the token survives a reload.
- Control, same project: `/privacy-policy?token=<canary>` (not a page of a mailed link): the
  canary is in the replay. This is the RED for the first test and the reason masking alone
  was not enough.
- A real replay cannot run under Vitest: the SDK switches it off outside a browser (jsdom
  counts as Node). A first attempt at a Vitest test like `sentry-tracing.spec.ts` sent no
  replay at all and was dropped.
- `playwright test --project=chromium --project=mock --project=sentry`: passing after
  `e2e/mock/unauthorized.spec.ts` was updated (it expected the token to stay in the address).
- Whole `e2e-live` suite on the real stack: 14 passed, including the password reset and e-mail
  verification through mailed links.
- Backend suites not run: no backend file changed.

## Notes for Next Session

Open lows: feat-206 (HTTP core and cookie), feat-207 (supply chain), feat-208 (push and
cleanup). A secret in the query of any other page is still sent by a replay; the docs say so.
