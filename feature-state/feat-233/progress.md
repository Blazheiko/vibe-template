# feat-233 Active Sessions — progress

Plan: `docs/plan/active-sessions-plan.md` (revision 5, Р1–Р14, T1–T8). Branch `feat/active-sessions`.
Registry PR #714 (merged).

## Current state

T1–T7 implemented, T8 checks run locally (below). Next: implementation PR, review, merge, then
"Mark feat-233 done".

- **T2 shared**: `parseUserAgent` / `describeDevice` (own parser, fixtures), `SessionView`, the three
  response schemas (`sessionRenewed` union), `ListSessionsQuery`, `CURRENT_SESSION_REASON`, contracts
  `listSessions` / `revokeSession` / `revokeOtherSessions`, broadcast event `user_sessions_changed`.
- **T3 session store**: `SessionData.device`; `vendor/utils/session/session-index.ts` with the Lua
  scripts `SESSION_CREATE` / `SESSION_DESTROY` / `SESSION_TOUCH` (type check before any write),
  `session_index:<token>` ZSET + `session_meta:<token>` HASH, keyset pages (50 / batch 64 / scan
  500, ties, dead-member cleanup), public id (HMAC, stored once), cursor; HTTP touch on the hourly
  cookie refresh (marker released after a failed write), WS touch (15 min, moves after success),
  touch on WS open; `auth.login(userId, token, origin)` answering the device; `destroyAllSessions`
  deletes both keys.
- **T4 service/controller**: `retirePendingResets` shared by logout-all, change-password and
  revoke-others; `session-list-service.ts`, `account-sessions-controller.ts`, routes in the
  `account` group; push `session_revoked`; `user_sessions_changed` from the session layer
  (`onSessionListChanged`, wired in `index.ts`), the service and the 0 ↔ 1 socket transitions of a
  session in the coordinator.
- **T5 notice**: `new-sign-in-notice.ts` (push with the device, mail rules: verified address, not a
  familiar device, `newSignInMailUser` 5/hour), callers per the Р11 table (OAuth registration no
  longer pushes; a claim pushes without a mail).
- **T6 frontend**: `base-api.ts` stale-401 rule (`renewsSession`, also on change-password),
  `ActiveSessions.vue` + `ConfirmDialog.vue` + `useActiveSessions.ts`, i18n en/uk/pl, guard for the
  new event, privacy policy line.
- **T7 docs**: `backend/account.md` (Active sessions), `auth.md` (Session list), `security.md`
  (New sign-in notice, limit row), `websocket.md`, `web-push-notification.md`,
  `configuration.md` (+ `.env.example`), both locales; recommendations item 2 marked.

## Deviations from the plan

- `lastTouchedAt` of a WS connection lives on its `UserConnection` (`sessionTouchedAt`, next to
  `messageBudget`), not in the registry entry: same lifetime, no lookup.
- `auth.login` answers the device of the new session (or `null`) instead of a boolean, so the OAuth
  service announces the sign-in without the session object.
- OAuth registration records `method: 'oauth'` with its provider; `register` is the email/phone
  registration.
- Race table (Р9): the loser gets `401 session_revoked` **or** `403 token_mismatch` — the latter when
  the winner's cleanup deleted its record before its request was restored (it is then an anonymous
  session with a mismatching CSRF token; the frontend refreshes and finds itself signed out). Both
  mean "your session is revoked"; the docs table says so. No new codes.
- Playwright: the two-browser scenarios are in `e2e-live/active-sessions.spec.ts` (real backend),
  not in the mocked `e2e/`.

## Observations (not changed here)

- A Node (undici) WebSocket client stays `CLOSING` after the server's `endSessionExpired` (send +
  `end(4001)` inside `cork`): the close event does not fire within 10 s. Browsers close normally
  (e2e-live: the other browser lands on /login). Same path as the existing feat-210 logout; the
  HTTP pg test therefore checks the `session_expired` frame and `readyState >= CLOSING`.

## Evidence of Completion

Local, on the branch after the last edit:

- `make check`: green — shared 73, backend 232 files / **3235 tests**, frontend 61 files / **730
  tests**, landing 103, api-playground 115, documentation 26; format, typecheck, lint, bundle graph.
- `PG_TEST_URL=… REDIS_TEST_URL=… make test-pg` (vitest pg config): 41 files, **389 passed, 0
  skipped** (new `account-sessions-http.pg.test.ts`: 11).
- `REDIS_TEST_URL=… make test-redis`: 19 files, **174 passed, 0 skipped** (new
  `session-index.redis.test.ts`: 21).
- `pnpm --filter frontend test:e2e`: **102 passed**.
- `pnpm --filter frontend test:e2e:live`: **25 passed** (new `active-sessions.spec.ts`: 4 — end one
  session and the other browser lands on /login; the online badge goes off; end all others keeps
  this browser; the sign-in mail with the IP and `/account#sessions`).
- `pnpm docs:build && pnpm docs:verify`: all checks passed.
- Mutations, each failing its tests and reverted: a write before the type check in
  `SESSION_CREATE` (2 fail), a touch without the field check (1), the equal-score group dropped from
  a page (2), the cursor at the last returned instead of the last looked-at member (2); the stale-401
  rule off (6 of 10 fail), the wait for an in-flight renewal off (1).

Manual golden path: automated in `e2e-live/active-sessions.spec.ts` (two browsers, mail sink); a
click-through by a person in a browser with Mailpit is not done.

## Notes for Next Session

- Open the implementation PR, wait for every CI job (`quality`, `e2e`, `e2e-live`, `test-pg`,
  `test-redis`), then the review-status PR and the merges per AGENTS.md.
