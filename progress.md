# feat-198: Sign-in Method Added Notification

Plan: `docs/plan/security-review-2026-11-12-plan.md`, S04. Finding: M-2 (part 1) of
`docs/security/security-review-2026-11-12.md`. Branch: `fix/sign-in-method-added-notice`.

## Current State

Done, in review.

- Linking another provider's identity to a verified account (`confirmLink`, `linkTrusted`) was
  announced as an ordinary `new_sign_in`, by push only. Such a link signs in after a password
  change, a reset and "log out everywhere".
- New security event `sign_in_method_added` (push) and a mail to the account's address with the
  provider's name (`sign-in-method-notice.ts`). Both are sent after the link is committed,
  fire-and-forget, and also when the session after the link could not be created.
- The provider's profile name is quoted in the mail only when `mailSafeDisplayName` accepts it
  (no URL or address shape, no control characters, one line, at most 60 characters); otherwise
  the mail says "A GitHub account".
- A claim is still announced as `account_claimed`, with no mail.
- The mail tells the owner to contact support: there is no way to unlink yet (feat-199 adds it
  and should point the mail to the account page).

## Files Modified

- `packages/backend/src/app/services/auth/sign-in-method-notice.ts` (new) and its spec
- `packages/backend/src/app/services/auth/oauth-service.ts` and its spec
- `packages/backend/src/app/services/notifications/user-notification-service.ts`,
  `email-templates.ts` (`mailSafeDisplayName`) and their specs
- docs uk+en: `backend/oauth.md`, `backend/web-push-notification.md`

## Evidence of Completion

- `make check`: passing (backend 2803, frontend 549, playground 115).
- `pnpm docs:build && pnpm docs:verify`: passing.
- `pnpm --filter backend test:pg` (31 files, 307 passed) and `test:redis` (11 files, 116
  passed) on real services.
- RED: with `oauth-service.ts` as on `main`, the new and changed cases of
  `oauth-service.spec.ts` fail (the link announced as `sign_in_method_added`, the mail, the
  notice when the session cannot be created).
- Manual: `notifySignInMethodAdded` through the real `emailService` to the local Mailpit: two
  mails arrived at the account address with the subject "A new sign-in method was added to your
  account"; the one for the profile "Jane Doe" quotes it, the one for the profile
  "Locked. Sign in at https://evil.example/x" says "A GitHub account" and contains no part of
  that name. OAuth itself was not run against a real provider.

## Notes for Next Session

Next in the chain: feat-199 (list and unlink sign-in methods, decisions Д2 and Д3). It reuses
`mailSafeDisplayName`; feat-203 (L-1) should use it for the link mail and the registration name.
