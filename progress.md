# feat-195: WS Closes On Session Revocation

Plan: `docs/plan/security-review-2026-11-12-plan.md`, S01. Finding: M-1 of
`docs/security/security-review-2026-11-12.md`. Branch: `fix/ws-close-on-revocation`.

## Current State

Done, in review.

- A heartbeat is not checked against the session, so a socket that only pings stayed open and
  subscribed (admin channel, support replies) after logout, logout everywhere, a password change
  or reset.
- The registry now keeps the `sessionId` and `users.session_token` every connection was opened
  with. `wsSessionRevocation.closeUserConnections(userId, { sessionId? })` closes them with the
  `session_expired` message and code 4001.
- Called from: `logout` (the sockets of that session), `logoutAll`, `changePassword`, and
  `destroySessionsQuietly` (password reset by email and phone, account claim, OAuth claim).
- Every instance re-checks all its connections against `users.session_token` once per
  `WS_SESSION_RECHECK_INTERVAL_MS` (default 30000), one query per 1000 users on the session-check
  pool, and closes those that differ or whose user is gone. This covers sockets held by another
  instance.
- Known limit, documented: a single-session `logout` does not rotate the token, so on another
  instance its socket is closed only by the next client message, as before.

## Files Modified

- `packages/backend/src/app/services/auth/ws-session-revocation.ts` (new) and its spec
- `packages/backend/src/vendor/utils/network/ws-session-expired.ts` (new; the 4001 close and the
  closed-socket check, shared by `ws-handlers.ts` and the admin re-check)
- `packages/backend/src/app/websocket/ws-connection-registry.ts`, `ws-coordinator.ts`
- `packages/backend/src/app/services/auth/auth-service.ts`, `account-claim-service.ts`
- `packages/backend/src/app/repositories/user/user-repository.ts` (`findSessionTokensByIds`)
- `packages/backend/src/config/websocket.ts`, `packages/backend/src/index.ts`, `.env.example`
- tests: `auth-service.spec.ts`, `account-claim-service.spec.ts`, `ws-registry-lifecycle.spec.ts`,
  `config/websocket.spec.ts`, `validate-runtime-config.spec.ts`, `session-revocation.pg.test.ts`,
  `packages/frontend/e2e-live/session-revocation.spec.ts`
- docs uk+en: `backend/websocket.md` (new section "Revoking a session"), `backend/auth.md`,
  `backend/configuration.md`

## Evidence of Completion

- `make check` (format, typecheck, lint, test): passing. backend 2734, frontend 548,
  playground 115.
- `pnpm docs:build && pnpm docs:verify`: all checks passed.
- `pnpm --filter backend test:pg` with `PG_TEST_URL` and `REDIS_TEST_URL` set: 31 files, 303
  tests passed, none skipped in `session-revocation.pg.test.ts` (20 passed). `test:redis`: 11
  files, 116 passed.
- RED: with the close call disabled in `ws-session-revocation.ts`, the six new cases of
  `session-revocation.pg.test.ts` fail (logout, logout everywhere, password change, reset by
  email, re-check after a rotation by another instance, deleted user); with the fix all 20 pass.
- Golden path on the real stack (`playwright.live.config.ts`: real backend on uWS, PostgreSQL,
  Redis, two browsers): `e2e-live/session-revocation.spec.ts` › "log out everywhere closes the
  open WebSocket of the other browser" — the other browser sends nothing, receives
  `session_expired` and its socket closes within 5 s (the 30 s re-check is not involved). 4 of 4
  tests in the file passed.
- The review's open question about `sendPingsAutomatically`: not needed for the finding. The
  client's own text `ping` is a message, so it resets the uWS `idleTimeout` (120 s) by itself.

## Notes for Next Session

Next in the chain: feat-196 (one-time WS token, L-12), then feat-197 (connection limits, M-4).
`sessionId` and `userToken` already live in the registry, which feat-196 builds on.
