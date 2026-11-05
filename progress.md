# feat-129 — Session Guard and Race Test (fifth review H3)

## State

Done on branch `fix/feat-129-session-guard`; start PR #420. Waiting for CI on the feature PR.

## Changes

- `services/auth/auth-service.ts`, `oauth-service.ts`: the session-still-stored guard of
  link-email/start, link-phone start/confirm and the OAuth first-address resend is a required
  parameter; `requireSessionStored(undefined)` used to pass. Callers that omit it no longer compile.
- `services/auth/email-verification-service.ts` + `auth-controller.ts`: `queueVerificationEmail`
  takes the guard and answers 401 `session_revoked` before queuing the mail.
- `controllers/http/notifications/push-subscription-controller.ts`: `testPush` checks
  `session.isStored()` before `sendToUser`.
- Tests:
    - `auth-controller.session-guard.spec.ts` (new): for startPhoneLink, confirmPhoneLink,
      startEmailLink and resendVerificationEmail the guard handed to the service is the request's
      own `session.isStored` (false and true both pass through, `isStored` called only when the guard
      runs).
    - `oauth-controller.spec.ts`: the same for resendEmailLink.
    - `push-subscription-controller.spec.ts`: test-push with the record gone → 401, nothing pushed.
    - `email-verification-service.contract.spec.ts`: queue with the record gone → 401, no mail,
      no token.
    - `phone-reset-transaction.pg.test.ts`: the two-completions race uses `bothReadBeforeEitherWrites`
      on `smsAuthChallengeRepository.findById`, so both completions read the pending challenge and
      reach the user lock (asserted: `lockById` called twice); one reset, one "no longer valid".
    - Existing service specs pass an explicit `sessionStillStored` guard.
- Docs: `documentation/backend/auth.md`, `web-push-notification.md`.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean
- `pnpm test`: backend 2417, frontend 400, api-playground 62
- `pnpm docs:build && pnpm docs:verify` pass
- test:pg on local PostgreSQL 17 (no Redis): 21 files / 169 passed, 7 Redis files skipped; the
  phone-reset file 8/8. Full test:pg and test:redis by CI.
- Mutation:
    - controller wiring replaced by `() => Promise.resolve(true)`: 3 wiring cases fail
    - test-push without the check: 1 fails
    - queueVerificationEmail without the check: 1 contract case fails
    - `markConfirmed` without its `confirmed_at IS NULL` / `invalidated_at IS NULL` conditions: the
      new race test fails. The old unbarriered test also failed in this run, but only by timing;
      the barrier makes it deterministic.

## Notes for Next Session

Last group of the fifth review: H4 (operations lows: purge keyset and dry-run pool, push endpoint
path/query, R11d COMMIT ambiguity, arctic code exchange timeout, lease release flag, `::ffff:` CIDR,
KB-init status after an ambiguous INSERT, XFF first header line).
