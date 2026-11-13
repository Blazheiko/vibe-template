# feat-199: Linked Sign-in Methods Management

Plan: `docs/plan/security-review-2026-11-12-plan.md`, S05. Finding: M-2 (part 2) of
`docs/security/security-review-2026-11-12.md`. Decisions Д2 and Д3. Branch:
`feat/linked-sign-in-methods`.

## Current State

Done, in review.

- `GET /api/auth/sign-in-methods` lists the OAuth identities linked to the account (id,
  provider, profile name when it is safe to show, date) and says whether the account has a
  password. `POST /api/auth/sign-in-methods/unlink` removes one. Both are in the `auth` web
  group with `auth_guard`, declared through route contracts.
- Re-authentication (Д3): an account with a password sends the current one (the shared
  `change_password_user` budget); an account without one must have signed in within 10 minutes.
  A sign-in always creates a new session, so the age of the session is used; no new session
  field was needed.
- The last way in is never removed: an account without a password keeps at least one link. The
  decision is made on the user row under `FOR UPDATE`.
- Another account's link id answers 404.
- After a removal: the `sign_in_method_removed` push.
- Д2: a password reset keeps the links. `reset-password` and `reset-phone/complete` answer with
  `signInMethods`, the page after the reset shows them, and the account's address gets a
  "Your password was reset" mail listing them.
- Frontend: a "Sign-in methods" block on the account page (en, uk, pl).
- The feat-198 mail and push now point to the account page instead of support.

Differences from the plan, both stricter:

- A phone or an email without a password does not count as a remaining way in (the plan counted
  a verified phone). Recovery through them needs an SMS provider or a mailbox; a password first
  is simpler to explain.
- A missing or wrong current password answers 400, like `change-password` and
  `link-email/start` do; 403 is only for the stale session of an account without a password.

## Files Modified

- shared: `schemas/auth/unlink-sign-in-method.ts`, `responses/auth-controller.ts`,
  `contracts/auth.ts`, `schemas/index.ts`
- backend: `services/auth/sign-in-methods-service.ts`, `password-reset-notice.ts`,
  `oauth-provider-titles.ts` (new); `controllers/http/auth/sign-in-methods-controller.ts` (new);
  `repositories/auth/oauth-account-repository.ts`; `routes/http-routes.ts`,
  `routes/contract-schemas/auth.ts`; `password-reset-service.ts`, `oauth-service.ts`,
  `sign-in-method-notice.ts`, `user-notification-service.ts`, `auth-controller.ts`; specs and
  `sign-in-methods.pg.test.ts`
- frontend: `views/UserAccount.vue`, `views/ResetPasswordView.vue`, `utils/api.ts`,
  `utils/oauth-provider-label.ts`, `locales/{en,uk,pl}.ts`, `views/__tests__/UserAccount.spec.ts`
- docs uk+en: `backend/oauth.md` (new section "Managing sign-in methods"), `backend/auth.md`,
  `backend/web-push-notification.md`

## Evidence of Completion

- `make check`: passing (backend 2837, frontend 558, playground 115).
- `pnpm docs:build && pnpm docs:verify`: passing.
- `pnpm --filter backend test:pg`: 32 files, 312 passed (one earlier run failed in
  `readiness-probe.pg.test.ts`, a timing test this change does not touch; it passed 3 of 3 alone,
  once on the unchanged tree, and in the next full run). `test:redis`: 11 files, 116 passed.
- `sign-in-methods.pg.test.ts` on a real PostgreSQL: another account's link is not removed (404,
  and the repository refuses it too); two removals at once leave one link.
- RED: without the "last method" rule two cases of `sign-in-methods.pg.test.ts` fail.
- `pnpm --filter frontend test:e2e` (chromium and mock projects): 83 passed. Whole `e2e-live`
  suite: 14 passed.
- Manual, on the real stack (`playwright.live.config.ts`, a temporary spec that inserted
  `oauth_accounts` rows through the local docker PostgreSQL; not committed): the account page
  listed GitHub and Google, did not show a profile name carrying a link, refused a wrong
  password, answered 404 for another account's link, removed GitHub with the right password
  (row gone), and answered 409 `last_sign_in_method` once the password was cleared. A reset by
  mail showed "GitLab" on the page after the reset and the notice mail arrived with it.
- Not run: an OAuth sign-in against a real provider, so "after unlinking the provider no longer
  signs in" rests on the repository lookup returning nothing (PG test), not on a live callback.

## Notes for Next Session

Next in the chain: feat-200 (OAuth flow hardening, L-6…L-9, I-2). Middle findings still open:
feat-201 and feat-202 (M-3).
