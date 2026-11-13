# feat-203: Verification Mail Abuse

Plan: `docs/plan/security-review-2026-11-12-plan.md`, S09. Findings: L-1, L-2 of
`docs/security/security-review-2026-11-12.md`. Decision Д5. Branch:
`fix/verification-mail-abuse`.

## Current State

Done, in review.

- **L-1 (Д5).** A mail to an address nobody has confirmed greets nobody by name: the email
  verification mail and the "confirm your new email" mail no longer take the account name.
  The password reset mail and the OAuth link mail greet by name only when the account's
  address is confirmed (`mailAddresseeName`). The OAuth link mail quotes the provider's
  profile name only when `mailSafeDisplayName` accepts it, otherwise it says "a GitHub
  account". `renderBrandedEmail` applies the same check to the greeting itself.
- **L-2.** The verification mail a sign-in to an unverified account sends now also spends the
  hourly budget of the resend button (`resendVerificationUser`, 3 per hour) and a new daily one
  (`verificationMailUserDaily`, 5 per day, `AUTH_VERIFICATION_MAIL_MAX_PER_USER_PER_DAY`). The
  resend button spends the daily budget too. The 5-minute interval stays and is checked first.
- Wider than the plan: the reset mail was not listed in the finding, but it had the same hole
  (register somebody's address with a hostile name, then ask for a reset).

## Files Modified

- `packages/backend/src/app/services/notifications/email-templates.ts`
- `packages/backend/src/app/services/auth/email-verification-service.ts`,
  `password-reset-service.ts`, `oauth-service.ts`, `auth-service.ts`
- `packages/backend/src/config/throttle-policies.ts`, `.env.example`
- tests: `auth-email-templates.snapshot.spec.ts` and five files in `__snapshots__/`,
  `email-templates.spec.ts`, `auth-service.spec.ts`, `oauth-service.spec.ts`,
  `email-verification-service.throttle-contract.spec.ts`, `throttle-policies.spec.ts`,
  `oauth-pre-hijack.pg.test.ts`
- docs uk+en: `backend/mail.md`, `backend/auth.md`, `backend/security.md`,
  `backend/configuration.md`

## Evidence of Completion

- `make check`: passing (backend 2933, frontend 558, playground 115).
- `pnpm docs:build && pnpm docs:verify`: passing.
- `pnpm --filter backend test:pg` (32 files, 313 passed) and `test:redis` (11 files, 117
  passed) on real services. `oauth-pre-hijack.pg.test.ts` was updated: a profile name with a
  link is not quoted at all (it used to be quoted escaped), and a new case pins the escaping
  of a name with markup characters and no link.
- RED: with the five service files as on `main`, 15 cases of four specs fail.
- Mail snapshots: the verification and link mails lost "Hello, <name>." (now "Hello."); the
  reset snapshot is now rendered for a confirmed account and keeps the name; the "markup" user
  has no closing tag any more, because a name with a slash is not quoted.
- Manual, on the real stack (`playwright.live.config.ts`, a temporary spec, not committed): an
  account registered with the name "Your account is locked. Sign in at https://evil.example/x"
  got a verification mail whose greeting is "Hello." and which contains neither "locked" nor
  "evil.example", in the text and in the raw message.
- Whole `e2e-live` suite: 14 passed.

## Notes for Next Session

Open lows: feat-204 (phone reset), feat-205 (Sentry replay), feat-206 (HTTP core and cookie),
feat-207 (supply chain), feat-208 (push and cleanup).
