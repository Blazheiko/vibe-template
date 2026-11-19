# feat-233 Active Sessions — progress

Plan: `docs/plan/active-sessions-plan.md` (revision 5, Р1–Р14, T1–T8). Branch `feat/active-sessions`.

## Current state

- T1 done: registry PR #714 merged.
- T2 done: shared `parseUserAgent` / `describeDevice`, `SessionView` and the three response schemas,
  `ListSessionsQuery`, `CURRENT_SESSION_REASON`, contracts, broadcast event `user_sessions_changed`.
- T3 in progress: device in `SessionData`, Lua scripts `SESSION_CREATE` / `SESSION_DESTROY` /
  `SESSION_TOUCH` with a type check first (`vendor/utils/session/session-index.ts`), keyset pages,
  public id, cursor, HTTP touch on the hourly refresh, WS touch (15 min, moves only after success),
  `auth.login(userId, token, origin)` answering the device.
- T4/T5 code written (service, controller, routes, notice); tests in progress.

## Baseline

`./init.sh` on `8031a6d`: green (backend 3177, frontend 699 tests).

## Deviations from the plan

- `lastTouchedAt` of a WS connection lives on its `UserConnection` (`sessionTouchedAt`), next to
  `messageBudget`, rather than in the registry entry: same lifetime, no extra lookup.
- `auth.login` answers the device of the new session (or null) instead of a boolean, so the
  OAuth service can announce the sign-in without the session object.
- OAuth registration records `method: 'oauth'` with its provider (the UI shows "GitHub"); `register`
  is for email/phone registration.

## Notes for Next Session

- Remaining: service/notice/controller unit tests, `*.pg.test.ts` HTTP scenarios, frontend (T6),
  docs (T7), checks (T8).
