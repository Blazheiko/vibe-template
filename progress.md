# feat-134 — Sixth Review Auth Lows (I1)

## State

Done on branch `fix/feat-134-auth-lows`; start PR #435. Waiting for CI on the feature PR.

## Changes

- **L1** `auth-service.ts` / `auth-controller.ts`: `changePassword` takes the required
  session-still-stored guard and checks it right before the password write. After a logout in
  another tab the change used to go through and `renewSession` signed the browser in again.
- **L2** `sms-challenge.ts`, `sms-auth-challenge-repository.ts`: `openChallenge` runs in one
  transaction under `pg_advisory_xact_lock(hashtextextended('sms_auth_challenge:<flow>:<phone>'))`,
  checks the resend cooldown again on the fresh row, retires and creates. Of two starts that both
  passed `findPendingChallenge`, the second now answers the 429 cooldown instead of leaving a second
  live challenge. `openChallenge` returns `AppResult`; repository `create` / `findLatestPending…`
  take an executor; new `lockPhoneFlow`.
- **L3** every spent auth throttle (registration, code / link verification, linking, reset, OAuth
  mail resend) answers `rateLimited` (429 `rate_limited`) instead of 400; the OAuth reason
  `too_many_attempts` is kept.
- Tests: contract case for the change-password guard; controller wiring for `changePassword`;
  `sms-start-race.pg.test.ts` (barrier on the pending read); throttle contracts and specs on 429;
  mock e2e register answer on 429.
- Docs: `documentation/backend/auth.md`.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean
- `pnpm test`: backend 2510, frontend 400, api-playground 62; docs build + verify
- local test:pg (no Redis): 173 passed, 7 Redis files skipped
- Mutation: without the change-password check 1 contract case fails; without the lock and the
  re-check the race test fails (3/3 runs: two challenges opened); the throttle contracts pin 429.
