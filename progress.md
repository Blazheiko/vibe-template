# Session Progress Log

## Current State

**Last Updated:** 2026-10-31
**Active Feature:** feat-057 - Anonymous Session Flood
**Branch:** `fix/anonymous-session-flood` (status PR #183: plan + feat-057 → `in_progress`)
**Plan:** `docs/plan/anonymous-session-flood-plan.md` (decisions: A + B, `SESSION_ANON_TTL` 2h; A as a signed cookie-held anonymous session)

## Status

### Done

- [x] Diagnosis: every request without a cookie to a `session_web` group wrote `session:anon_session:<id>` (24h) + `session_cookie_refresh:<id>` (1h) to Redis, even on a 401 — the feat-052 benchmarks had piled up ≈ 8.8M keys / 2.7 GB locally
- [x] Inventory: `csrf-guard`, `session-web` (`attachCsrfToken` — the frontend takes the anonymous CSRF token from the 401 of `GET main/init`), `main-service`, `auth-service` (login/logout/`destroySession`), `oauth-controller` (`updateSessionData` for `state`), `auth-controller`
- [x] Tests first (`csrf-bootstrap.redis.test.ts`, real Redis): init and an anonymous mutation write no key; tampered / expired / user-signed-as-anonymous cookies are rejected; a cookie older than 15 min is re-issued with the same token; storing data moves the session to Redis with `SESSION_ANON_TTL`; logout hands out a cookie-held session. `session-before-send.spec.ts`: new anonymous session stores nothing; a failed refresh marker does not fail the login
- [x] `token-handler.ts`: `createAnonSessionToken` / `verifyAnonSessionToken` (`anon-v1.<sessionId>.<csrfToken>.<issuedAt>` + HMAC)
- [x] `session-handler.ts`: cookie-held anonymous session, 15-min sliding re-issue, moves to Redis on `updateSessionData` / `changeSessionData`; logout / logoutAll issue a cookie-held session
- [x] `redis-session-storage.ts`: TTL by kind (`anon_session` → `anonAge`); `config/session.ts`: `anonAge` from `SESSION_ANON_TTL` (default `2h`, a non-positive duration throws at start)
- [x] Docs: `backend/auth.md` (new «Анонімна сесія» section, TTL table, rotation, diagram), `security.md`, `controllers.md`, `configuration.md`; `.env.example`

- [x] Review of PR #184 (REQUEST CHANGES): (1) HIGH — a slow anonymous response re-issuing its aged cookie could overwrite the cookie of a login or an OAuth move to Redis made meanwhile; the re-issue now goes through `beforeSend` (`discardStaleSessionCookie`): login from a cookie-held session leaves `session_superseded:<id>` (15 min), a move to Redis leaves `session:anon_session:<id>`; either one holds the late cookie back, a request that swapped its own session keeps it, a failed check drops it. (2) MEDIUM — a fresh anonymous cookie found only under the legacy name is now re-issued under the active one (`forceCookie`). Tests first: login race, Redis-move race, unchallenged refresh, own move, legacy name (Redis); failed check (unit)

- [x] Second review of PR #184 (HIGH): after anonymous cookie → move to Redis → login, the login deleted the stored record without a marker, so a slow refresh of the first request found no trace and re-issued the stale cookie. Login now marks **any** anonymous predecessor (cookie-held or stored) with `session_superseded:<id>` before deleting it. Test first: «a slow response does not overwrite a login made after a move to Redis». `register/email` deletes the anonymous session without issuing a cookie, so there is no newer cookie a late response could overwrite — left as is

- [x] Third review of PR #184 (HIGH): a request that moved its session to Redis was in `swappedSession` and skipped the check, so its late response could undo a login made meanwhile with the same original cookie. The move now has its own pending check: before sending it looks only at the login marker `session_superseded:<id>` (its own record is no sign of a change), whatever the age of the original cookie; only login/logout keep their cookie unconditionally. Login also deletes an `anon_session` record a parallel request may have created. Tests first: promotion-vs-login race (Redis), failed promotion check (unit)

### Behaviour change to know

A cookie-held anonymous session cannot be revoked before its TTL: after login the old anonymous cookie + token still pass the CSRF check, but only as an anonymous session; the token does not sign requests of the user's session (test «an anonymous cookie never opens the session of the user who logged in with it»). Previously login deleted the anonymous record, so the old pair got `403`.

## Evidence of Completion

| Check                                                                           | Result                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check` / `build`                            | exit 0                                                                                                                                                                            |
| `pnpm test`                                                                     | backend 1175, frontend 168, api-playground 14, shared 14, docs 26                                                                                                                 |
| `test:redis` (`REDIS_TEST_URL=redis://127.0.0.1:6379/15`)                       | 54 passed (was 45; +9 feat-057)                                                                                                                                                   |
| `test:pg`                                                                       | 23 passed                                                                                                                                                                         |
| `CI=1 pnpm --filter frontend test:e2e`                                          | 12 passed                                                                                                                                                                         |
| `test:e2e:security` (real prod server, port 3200, fixture restored)             | 7 passed                                                                                                                                                                          |
| `docs:build && docs:verify`                                                     | passed                                                                                                                                                                            |
| Load proof: `wrk -c100 -d30s /api/main/init` without a cookie, same `bench.env` | `main`: 575 694 requests → 1 151 570 new Redis keys (**2.0 per request**), 19 147 req/s; branch: 1 000 595 requests → **0 new keys**, 33 330 req/s; `Redis unavailable` 0 in both |

## Notes for Next Session

1. Merge status PR #183 and the feature PR, then the done-PR
