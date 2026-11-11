# feat-154 — Sign-in Redirect (V08)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V08), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (V08.S–V08.X). Finding M10 of
`docs/plan/code-review-2026-11-10-report.md`; AC-AUTH-001.

## Goal

The router guard sends an anonymous visitor of a protected page to `/login?redirect=<path>`.
After a sign-in the visitor landed on `/account` whatever the redirect said: closing the modal
replaced the route (and dropped the query) before anything read it. An OAuth sign-in lost the
target too, because it leaves the application and comes back to `/`.

## State

Done, waiting for review and merge.

## What changed

- `packages/frontend/src/composables/useCompleteSignIn.ts` — reads
  `safeRedirectTarget(route.query.redirect)` before the modal is closed and goes there (else to
  the account page); the app reads the session (`init_app`) only after the navigation settled, so
  its own "where to after a sign-in" rule sees the new page.
- `packages/frontend/src/utils/post-sign-in-target.ts` (new) — keeps the target in the tab's
  `sessionStorage` for an OAuth round trip: validated when stored and again when taken, taken
  once, good for ten minutes.
- `packages/frontend/src/components/SocialAuthButtons.vue` — a click on a provider button
  remembers the target (or forgets a stale one).
- `packages/frontend/src/App.vue` — after an OAuth return the stored target is used.
- Tests: `composables/__tests__/auth-composables.spec.ts` (+9), `utils/__tests__/post-sign-in-target.spec.ts`
  (new, 11), `e2e-live/sign-in-redirect.spec.ts` (new, 3).
- Docs (both locales): `backend/oauth.md`.

## Evidence of Completion

### V08.T — RED (before the fix)

Unit, `auth-composables.spec.ts`:

```
 × goes to the page the router guard remembered in ?redirect=
   AssertionError: expected "vi.fn()" to be called with arguments: [ '/support' ]
 × has the app read the session only after the navigation settled, so init sees the new page
 × forgets a target remembered for an OAuth sign-in that was not finished
 Tests  3 failed | 21 passed (24)
```

In a real browser, `e2e-live/sign-in-redirect.spec.ts` on the old code: the scenario "after a
sign-in the visitor is on the page they were going to" failed — the support page never appeared
(the visitor was on `/account`). The two other scenarios (a redirect outside the application is
ignored; no redirect → `/account`) passed before the fix and stay as regression tests.

### After the fix

- `make check`: frontend 38 files / 452 tests, backend 2605, api-playground 62.
- `pnpm --filter frontend test:e2e`: 87 passed.
- `pnpm --filter frontend test:e2e:live`: 12 passed, twice (the second time with the final,
  stricter URL checks of the new spec).
- `pnpm docs:build && pnpm docs:verify`: passed.

### Not verified

- The OAuth path in a browser: the live e2e has no OAuth provider. The storage helper and the
  click are covered by unit tests; the read at app init is one line in `App.vue` without a test of
  its own.

## Notes for Next Session

- `init_app` is now emitted after the post-sign-in navigation settles instead of right after it
  starts. `e2e-live/support.ts` has a note that the modal "now and then" left the page on the home
  page after a sign-in; that race was between the modal's `replace` and this `push` and is not
  what this feature changed.
