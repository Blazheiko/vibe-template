# feat-259: MFA Review Fixes 9

## Status

Implemented, ready for review. Branch `fix/mfa-review-9`. Plan: section feat-259 of
`docs/plan/mfa-review-fixes-7-plan.md` (review of feat-258, 2026-11-24).

## Scope

- 9.1 The full 8.1 scenario over HTTP (`mfa-sign-in-http.pg.test.ts`,
  `confirmedParallelSignIn`): attempt B (TOTP) is held at the user row lock while attempt A
  (recovery code) confirms the sign-in and gets `mfa_completion_pending`; B then answers 503
  (Redis failure in `deleteIfOpen`) or 401 `mfa_ticket_used` and keeps both MFA cookies; the
  continuation finishes A's sign-in (200, codes spent once, one new session).
- 9.2 `TotpService.confirm` accepts a pending setup only when `totpEnrollmentId` in the session
  data equals `input.enrollmentId`; otherwise 400 `enrollment_not_found` (set up again), nothing
  written. A repeat of an already committed enrollment still finishes its session write.
  No transition layer (template without backward compatibility).

## Evidence of Completion

- `make check` green: backend 3702, frontend 1017, shared 149, landing 103, api-playground 115,
  documentation 26.
- `pnpm --filter backend test:pg` (PG_TEST_URL set, pgvector/pgvector:pg16): 72 files,
  723 passed, 0 skipped.
- `pnpm --filter backend test:redis` (REDIS_TEST_URL set): 20 files, 205 passed, 0 skipped.
- `pnpm --filter frontend test:e2e`: 134 passed.
- Mutation checks (reverted afterwards): wrapping the revoked-branch `deleteIfOpen` in
  `bestEffort` (the pre-8.1 behaviour) fails both 9.1 tests (401 instead of 503); dropping the
  `totpEnrollmentId` check fails "a setup without its id key is set up again".
- Documentation: no change; the MFA page does not describe the session keys of the TOTP setup,
  and the public behaviour of setup/confirm is unchanged.
- CI on the branch: see the PR.

## Manual verification

Golden path unchanged (TOTP setup → confirm, sign-in with the second step); covered over real
HTTP against real PostgreSQL and Redis by the PG suites above.
