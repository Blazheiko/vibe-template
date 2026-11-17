# feat-221: Password Change Keeps The Session Signed In

Owner: Blazheiko · Branch: `fix/password-change-ws-race` · Status PR: #672

## Problem

`POST /auth/change-password` rotated `users.session_token`, then the service closed every
WebSocket of the user with `4001`, and only then did the controller renew the HTTP session. The
close frame reached the browser before the HTTP answer. The client refreshed the WS token at once
(`GET /main/update-ws-token`) with the old cookie, `auth_guard` answered `401` (token already
rotated), and `unauthorized` sent the user to `/login`. That happened although the change itself
answered `sessionRenewed: true` with a new cookie. Found in code review, not reproduced in a
browser.

## Fix

Server (`packages/backend`):

- `wsSessionRevocation.closeUserConnections` and `wsConnectionRegistry.revokeConnecting` take an
  `exceptSessionId`.
- `authService.changePassword` takes the requesting session id and closes the sockets of every
  other session at once, sparing its own.
- `AuthController.changePassword` closes the requesting session's sockets when the renewal fails.
  After a renewal the client replaces its socket, and the re-check pass closes anything left (its
  token is rotated).

Client (`packages/frontend`):

- `useWebSocketConnection` gains `suspendReconnect()` / `resumeReconnect()`. While suspended, a
  token refresh (after 4001, a refused handshake or a delayed reconnect) is only remembered.
  `websocketOpen()` drops a remembered refresh, and `resumeReconnect()` runs it otherwise.
- `UserAccount.vue` suspends before the request and resumes in `finally`, after `websocketOpen`
  with the renewed token.

Docs: `documentation/backend/{auth,websocket}.md` and their `en/` twins.

## Files modified

- packages/backend/src/app/websocket/ws-connection-registry.ts
- packages/backend/src/app/services/auth/ws-session-revocation.ts (+ spec)
- packages/backend/src/app/services/auth/auth-service.ts (+ auth-service.spec.ts)
- packages/backend/src/app/controllers/http/auth/auth-controller.ts (+ change-password spec)
- packages/frontend/src/composables/useWebSocketConnection.ts (+ spec)
- packages/frontend/src/views/UserAccount.vue (+ spec)
- documentation/backend/auth.md, documentation/backend/websocket.md (+ en)

## Evidence of Completion

- Baseline `./init.sh`: red only on the two specs whose source had been edited mid-run (the
  updated revokeConnecting arity and the new changePassword argument). Frontend 607, landing 103,
  playground 115 and the remaining backend tests were green.
- Mutation check: with the suspension disabled in `unauthorized()`, the three race tests in
  `useWebSocketConnection.spec.ts` fail (`4001 before the answer`, `held-back refresh`, `delayed
reconnect`).
- `make check` passing after the last edit: backend 210 files / 2988 tests, frontend 55 / 614,
  landing 103, api-playground 115.
- `pnpm --filter frontend test:e2e`: 99 passed.
- `pnpm docs:build && pnpm docs:verify`: passing (`verify-dist: all checks passed`).
- PG / Redis suites: Docker is not available locally; evidence is the `test-pg` / `test-redis`
  CI jobs of the PR.

- Manual golden path (sign in, open the account page, change the password, stay signed in with a
  live WebSocket): not done locally, because there is no Docker and so no PG/Redis. To do before
  `review`.

## Notes for Next Session

- Run the manual golden path once services are up (`make services-up`, `pnpm dev`).
