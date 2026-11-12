# feat-196: One-Time WS Token

Plan: `docs/plan/security-review-2026-11-12-plan.md`, S02. Finding: L-12 of
`docs/security/security-review-2026-11-12.md`. Branch: `fix/ws-one-time-token`.

## Current State

Done, in review.

- The WS token was read with `GET`, and every message and heartbeat of the first socket extended
  its TTL to 120 s. The token travels in `Sec-WebSocket-Protocol`, so whoever saw it could open
  more sockets as the user, with no cookie, while the first socket lived.
- `verifyUpgradeToken` now reads it with `GETDEL`: one token opens one connection, and of two
  upgrades racing with one token exactly one gets the record. The token is consumed whatever
  the answer.
- `sessionId` and `userToken` live only in `userData`. `onRefreshToken`, `onRevokeToken`,
  `wsSessionAuth.refreshToken` / `revokeToken` and `userData.token` are gone: a message or a
  heartbeat costs no Redis command for the token, and a close has nothing to revoke.
- Frontend: a reconnect after a lost connection takes a new token first (`update-ws-token`)
  instead of trying the spent one. Before, that retry failed too (the token was deleted at
  close) and only then refreshed.
- Not changed: the api-playground client still retries with the old token after a drop and then
  needs a new one from the user; it behaved the same before (the token was deleted at close).

## Files Modified

- `packages/backend/src/app/websocket/ws-session-auth.ts`, `app/start/index.ts`
- `packages/backend/src/vendor/utils/network/ws-handlers.ts`, `vendor/types/types.d.ts`
- `packages/frontend/src/composables/useWebSocketConnection.ts` and its spec
- backend tests: `ws-session-auth.spec.ts`, `ws-registry-lifecycle.pg.test.ts`,
  `ws-close-lifecycle.spec.ts`, `ws-message-budget.spec.ts`, `ws-redis-unavailable.spec.ts`,
  and the hook stubs of nine transport and upgrade specs
- docs uk+en: `backend/websocket.md`, `backend/auth.md`, `backend/request-lifecycle.md`

## Evidence of Completion

- `make check`: passing (backend 2735, frontend 549, playground 115).
- `pnpm docs:build && pnpm docs:verify`: all checks passed.
- `pnpm --filter backend test:pg` (31 files, 305 passed) and `test:redis` (11 files, 116
  passed) on real services.
- RED: with `GET` instead of `GETDEL`, both new cases of `ws-registry-lifecycle.pg.test.ts`
  fail on the real uWS server ("a WS token opens one connection: the second upgrade with it is
  refused", "of two upgrades racing with one token exactly one opens"); with the fix 4 of 4 pass.
- Real stack: the whole `e2e-live` suite, 14 of 14 passed (sign-in, reconnects after a password
  change, sign-out without a reconnect, socket closing on revocation).

## Notes for Next Session

Next in the chain: feat-197 (WS connection limits, M-4, L-11, L-13). A message no longer costs
a Redis command for the token, which is part of what M-4 counted.
