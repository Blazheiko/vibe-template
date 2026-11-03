# Progress: feat-098 OAuth Pre-Hijack Review Follow-ups

Branch: `fix/feat-098-oauth-review-followups`. Source: review of feat-096/097 (three findings), built on feat-097.

## State

- All three findings fixed with tests and docs; PR open. Next: green CI → merge → «Mark feat-098 done» PR.

## Findings and fixes

1. **P1: a push subscription from a revoked session after a claim.** New `withCurrentSession(userId, presentedToken, work)` ([`session-guard.ts`](packages/backend/src/app/services/auth/session-guard.ts)): one transaction, `lockById` (the claim's lock), presented token compared under it, else `401 session_revoked`. `createSubscription` (incl. moving an endpoint) and `updateSubscription` write through it; the repository methods take an executor. Controllers pass `context.auth.getPresentedUserToken()`.
2. **P1: OAuth mail paths skipped the email-link throttles.** New `enforceEmailLinkThrottles(email, userId, rejected)` in [`enforce-throttle.ts`](packages/backend/src/app/services/auth/enforce-throttle.ts) (`linkEmailTarget`, `linkEmailUser`, `linkEmailUserCooldown`), used by `startEmailLink` (unchanged behaviour), `startMailedLink` (before the token: a spent budget neither mails nor retires the owner's pending link), `resendFirstEmailLink` (before any lookup) and the first mail of a new OAuth user (skipped, the sign-in stands). Error reason `too_many_attempts`, whitelisted for the callback redirect and shown on the login page (en/uk/pl).
3. **P2: new OAuth user and its first link were not atomic.** `signInWithIdentity` creates both in one transaction (`userRepository.create(…, tx)`); a unique violation (a concurrent callback committed the link, or the Google address) re-runs the decision once and signs in by the winner's link; a second violation or another error is thrown.

## Files modified

- Backend: `session-guard.ts` (+spec, new), `enforce-throttle.ts` (+spec), `oauth-service.ts` (+spec), `auth-service.ts`, `push-subscription-service.ts` (+spec), `push-subscription-repository.ts`, `user-repository.ts`, `oauth-controller.ts` (+spec), `push-subscription-controller.ts`.
- pg tests: `oauth-pre-hijack.pg.test.ts` (+4), `push-subscription-ownership.pg.test.ts` (fake session presents the real token; +1 revoked session over HTTP).
- Frontend: `Login.vue`, locales en/uk/pl, `e2e/mock/oauth-link.spec.ts` (+1).
- Docs: `documentation/backend/auth.md`, `oauth.md`, `security.md`, `web-push-notification.md`.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 2119 / frontend 400 / api-playground 62 / shared 25 / documentation 26.
- `test:pg` 178 (with Redis), `test:redis` 88.
- New pg tests: push subscription after a completed claim → `session_revoked`, nothing inserted; push subscription waiting on a held user lock while the token rotates → `session_revoked`; control with the current token → written; two concurrent callbacks of one new identity → one user, one link, both browsers signed in to it; HTTP `POST /push-subscriptions` with a stale token → 401, nothing inserted.
- Mutation checks, each fails a pg test: guard without the token compare (2 fail); guard reading the token without the lock (1 fails); user and link created without a transaction (1 fails). Throttle paths covered by unit tests (budget consumed before token/mail; spent budget → no token, no mail, no retired link).
- Playwright mock 87/87 (+1: `reason=too_many_attempts` explained).
- `pnpm docs:build && pnpm docs:verify` clean.
- Manual on `dist` (fresh migrated DB, real Redis): login 200; `POST /api/push-subscriptions` 200; `PUT …/:id` 200; after rotating `users.session_token` (what a claim does) the next `POST` → 401 and no row written. The in-flight race itself is not reproducible by hand; it is proved by the pg tests above.
