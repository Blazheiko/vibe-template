# feat-090 — Result For Expected Outcomes (2/3)

Plan: `docs/plan/error-handling-fix-plan.md`, stage 4, PR 2 of 3. ADR: `docs/adr/0004-result-for-expected-outcomes.md`.

## Current state

Implemented, awaiting review. Start PR #300 merged (feat-089 → done, feat-090 → `in_progress`).

## Changes

- `oauth-service`, `email-verification-service`, `password-reset-service`, `sms-challenge`, `one-time-token`: 37 `tryInternal` calls removed (34 left: `auth-service` 33, `enforce-throttle` 1 — PR 3/3).
- Helper APIs lost their "public 500 text" parameters: `issueToken` and `openChallenge` return the value; `consumeTokenAndApply` throws when the transaction fails; `findPendingChallenge`, `issueSmsChallenge`, `deliverChallenge`, `confirmChallenge` keep `Result` for business answers only. `deliverChallenge` invalidates the challenge and rethrows when the provider or the record step fails. Call sites in `auth-service` updated (arguments only).
- `emailService.send` throws on a transport failure (no own `error` record with the recipient address). Fixes the double logging noted in feat-086; background senders log once.
- OAuth callback catches a thrown service failure and still redirects (logs it via `redirectToError`).
- `requestPasswordReset` / `startPhonePasswordReset`: the deliberate catches (same generic answer, no account enumeration) are explicit `try/catch` now.
- `isUniqueViolation` (`repositories/db-errors.ts`): reads `23505` on the error or its `cause`.

## Bug found and fixed

On `main`, the email-link race decided by the unique index answered **500, not 409**: Drizzle wraps the pg error in `DrizzleQueryError` (code on `cause`), and the old check read `code` from the wrapper. The unit test mocked a raw error with `code`, so it passed. New PG test with a real unique index; with the `cause` branch removed from `isUniqueViolation` it fails.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 1922, frontend 373, api-playground 62, shared 25, documentation 26 passed.
- `test:redis` 89, `test:pg` 153 (local; token race / rollback suites included).
- `pnpm docs:build && pnpm docs:verify` passed.
- Contract tables: rows whose failure now propagates are marked `throws: true` (the harness checks `rejects`); business rows unchanged.
- Manual on a fresh `dist` build, SMTP on a closed port: forgot-password for a known and an unknown address both answer 200 with the generic text; the log has exactly one `error` per background send (`Unexpected error while sending … in background`) with the cause. Test user deleted afterwards.

## Files modified

- `packages/backend/src/app/services/auth/{oauth,email-verification,password-reset,auth}-service.ts`, `sms-challenge.ts`, `one-time-token.ts`, `services/notifications/email-service.ts`, `repositories/db-errors.ts` (new), `controllers/http/auth/oauth-controller.ts`
- Tests: the three contract specs, `one-time-token.spec.ts`, `sms-challenge.spec.ts`, `email-verification-service.spec.ts`, `email-service.spec.ts`, `oauth-controller.spec.ts`, `db-errors.spec.ts` (new), `one-time-token-race.pg.test.ts`
- Docs: `documentation/backend/{repositories,mail}.md`; plan stage 4 notes

## Next step

Review + merge, then "Mark feat-090 done" and PR 3/3: `auth-service` and `enforce-throttle` (34 calls), then remove `tryInternal` / `toInternalError`.
