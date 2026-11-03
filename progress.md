# Progress: feat-097 OAuth Pre-Hijack Protection

Branch: `fix/feat-097-oauth-pre-hijack`. Plan: [`docs/plan/oauth-pre-hijack-plan.md`](docs/plan/oauth-pre-hijack-plan.md) (ревізія 5.1), built on feat-096.

## State

- Implementation, tests and docs done; PR open. Next: green CI → merge → «Mark feat-097 done» PR.

## Files modified

- Schema + migration `20261103055308_oauth_link_verifications`: table `oauth_link_verifications`, column `password_reset_tokens.target_email`.
- Repositories: `oauth-link-verification-repository.ts` (new), `oauth-account-repository.ts` (`findLinkForUser`, `create(…, tx)`, `deleteByUserId`), `push-subscription-repository.ts` (`deleteByUserId`), `token-repository.ts` (union), `sms-auth-challenge-repository.ts`.
- Services: `account-claim-service.ts` (new: `addressMatches`, `claimLocked`), `oauth-service.ts` (`emailTrust`/`googleEmailTrust`, callback table, `confirmLink`, `resendFirstEmailLink`), `email-verification-service.ts` (owner proof), `password-reset-service.ts` (claim, `target_email`), `one-time-token.ts` (`extra` from the locked row, `invalidatePending`), notifications (`account_claimed`), throttle `verifyEmailPasswordUser`.
- Routes: `POST /api/auth/oauth/link/confirm`, `POST /api/auth/oauth/email/resend`; `verify-email` takes `password`. Config `OAUTH_FRONTEND_LINK_PENDING_URL`, `AUTH_VERIFY_EMAIL_PASSWORD_MAX_ATTEMPTS_PER_HOUR`.
- Frontend: `OAuthLinkConfirmView.vue` (new route `/oauth/link/confirm`), `VerifyEmailView.vue` (password step), `Login.vue` (link_pending + reasons), `UserAccount.vue` (pending email + resend), API client, locales en/uk/pl.
- Docs: `documentation/backend/oauth.md`, `auth.md`, `database.md`, `security.md`, `configuration.md`.

## Decisions

- Claim keeps the account's data, `name` and `avatar` included (plan text updated).
- Claim also deletes push subscriptions: otherwise the previous holder's devices keep receiving the owner's notifications.
- The account page shows "email awaits confirmation" when the user has neither email nor phone; there is no explicit `pendingEmail` flag in `init` (an OAuth account cannot link a phone without first setting a password).
- `OAUTH_EMAIL_UNVERIFIED` removed (no compatibility needed).

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 2102 / frontend 400 / api-playground 62 / shared 25 / documentation 26.
- `test:pg` 173 (incl. `oauth-pre-hijack.pg.test.ts`: paths A–G, mailed link session binding, address change, sign-in vs claim race, reset claim), `test:redis` 88.
- Frontend Playwright mock project 74/74 (5 new in `e2e/mock/oauth-link.spec.ts`).
- `pnpm docs:build && pnpm docs:verify` clean.
- Mutation checks, each fails a pg test: claim never strips; no link re-check under the lock; no session binding; every Google address trusted; registration link without password; email link without own session.
- Manual on `dist` (fresh migrated DB): `/auth/verify-email` registration link without password → 403 `password_required`, wrong → 400 `invalid_password`, right → 200 and verified; `/auth/oauth/link/confirm` unknown token → 400 `invalid_token`; `/auth/oauth/email/resend` signed out → 401. Real provider sign-in not exercised (no provider credentials locally; covered by pg tests with stubbed providers).
