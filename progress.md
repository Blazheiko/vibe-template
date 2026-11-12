# feat-209: WS Revocation Race At Connect

Follow-up to feat-195 (security review 2026-11-12, M-1). Branch:
`fix/ws-revocation-race-at-connect`.

## Current State

Done, in review.

- How it was found: the `e2e-live` job failed on PR #593 ("Mark feat-195 done") in the test
  feat-195 added, `"log out everywhere" closes the open WebSocket of the other browser`. It had
  passed on PR #592 and locally. PR #593 was merged with that job red (`quality` and `e2e`, the
  required checks, were green).
- Cause: a connection passes the upgrade, then `handleConnected` awaits a database read before
  it registers the socket. A session revoked in that interval closed the connections in the
  registry, and this one was not there yet: it was registered afterwards and stayed open until
  the periodic re-check (up to `WS_SESSION_RECHECK_INTERVAL_MS`, 30 s). The test started the
  revocation as soon as the browser created the socket, so it sometimes hit that interval.
- Fix: the read in `handleConnected` returns the role together with the current
  `users.session_token` (`userRoleService.findAccess`). A connection whose token is no longer
  current, or whose user is gone, is closed with 4001 and never registered. Nothing is awaited
  between the read and the registration, so a revocation committed after the read finds the
  connection in the registry.
- The live test now waits for `service:connection_established` before the revocation, so it
  tests an open socket deterministically; the connect-time case has its own unit tests.

## Files Modified

- `packages/backend/src/app/websocket/ws-coordinator.ts`
- `packages/backend/src/app/services/user/user-role-service.ts` (`findAccess`)
- `packages/backend/src/app/websocket/ws-registry-lifecycle.spec.ts`
- `packages/frontend/e2e-live/session-revocation.spec.ts`
- docs uk+en: `backend/websocket.md` ("Revoking a session")

## Evidence of Completion

- `make check`: passing (backend 2738, frontend 548, playground 115).
- `pnpm docs:build && pnpm docs:verify`: passing.
- `pnpm --filter backend test:pg` (31 files, 303 passed) and `test:redis` (11 files, 116
  passed) on real services.
- RED: without the token comparison in `handleConnected`, `ws-registry-lifecycle.spec.ts` ›
  "closes the connection with 4001 instead of registering it" fails; with it 13 of 13 pass.
- Real stack: `e2e-live` `session-revocation` and `ws-close-after-logout` with
  `--repeat-each 5`: 25 of 25 passed.

## Notes for Next Session

Next in the plan (`docs/plan/security-review-2026-11-12-plan.md`): feat-196 (one-time WS token).
Wait for every CI job, `e2e-live` included, before merging, not only the required ones.
