# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-062 - WS Admin Revocation
**Branch:** `fix/ws-admin-revoke`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase C

## Status

### Done

- [x] Diagnosis: a WebSocket connection read `userData.role` once, when it was opened, and subscribed to the `admin` channel once. Heartbeats keep a connection open for days, so an admin demoted in the database kept receiving the admin broadcasts without sending a single request, and `ws_admin_guard` (which reads the same cached role) kept letting the admin routes through
- [x] Finding that changes the plan: **nothing in the application changes `users.role`** — no endpoint (`auth.md`: «ендпоінта немає»), `userRepository.update` does not write it, the seed never updates an existing user. A role changes only in the database, out of band. The planned pub/sub layer («role changed» event published from an admin service) has no producer, so it is not built; the periodic re-check is the whole guarantee, and the only mechanism that observes an out-of-band change
- [x] `adminWsAccessService.recheckAdminConnections()` — every instance takes its own connections that hold the `admin` role, reads the roles of their users with ONE query (`userRepository.findRolesByIds`), and calls `adminWsChannelService.revokeAdminAccess(ws)` for those whose role is no longer `admin` (or whose user is gone): the connection leaves the `admin` channel, its cached role drops to `user`, so the admin routes answer `403` and it cannot subscribe again. The connection stays open (its other functions, e.g. the support chat, are not interrupted). A connection closed while the query ran is skipped
- [x] Timer: `WS_ADMIN_RECHECK_INTERVAL_MS` (default 30000, integer 100…3600000, validated at start), one pass at a time, a failed pass is logged and the timer keeps going, `unref()`, stopped on graceful shutdown (`index.ts`)
- [x] Only downgrades are mirrored: a role is raised when a connection is opened, never by the background timer. A promoted user reconnects
- [x] Docs: `backend/websocket.md` («Відкликання admin-доступу» — the guarantee, the bound and its limits), `backend/configuration.md`, `backend/auth.md`, `.env.example`; plan phase C records what was built and what was not, and why

### Behaviour changes to know

- An admin demoted in the database stops receiving admin broadcasts and gets `403` on `admin/*` WebSocket routes within `WS_ADMIN_RECHECK_INTERVAL_MS` plus one pass (default ≈ 30 s) — not instantly. The connection is not closed.
- While the database cannot answer, a demotion cannot be observed: the pass fails (logged) and changes nothing; every WebSocket message is refused meanwhile by the session check (ADR 0002), but the broadcast subscription stays until the first successful pass.
- A promotion needs a reconnect (unchanged).

## Evidence of Completion

| Check                                                                                                                                                             | Result                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mutation check (the re-check never starts)                                                                                                                        | 6 of 9 `admin-ws-revocation.pg.test.ts` tests fail; the 3 that pass (baseline, reconnect, promotion) do not depend on the re-check                                    |
| `pnpm typecheck` / `lint` / `format:check`                                                                                                                        | exit 0                                                                                                                                                                |
| `pnpm test`                                                                                                                                                       | backend 1249, frontend 168, api-playground 14, shared 14, docs 26; exit 0                                                                                             |
| `test:pg` with Redis                                                                                                                                              | 77 passed in 10 files (9 new in `admin-ws-revocation.pg.test.ts`: real uWebSockets.js server, real WebSocket clients, Redis sessions, PostgreSQL; stable over 3 runs) |
| `test:pg` with Redis unreachable                                                                                                                                  | 51 passed, 26 skipped                                                                                                                                                 |
| `test:redis`                                                                                                                                                      | 61 passed                                                                                                                                                             |
| `docs:build && docs:verify`                                                                                                                                       | passed                                                                                                                                                                |
| `test:e2e:security` (real prod build and server on port 3200, so `index.ts` starts and stops the timer; fixture restored, `public` rebuilt with the default port) | 7 passed                                                                                                                                                              |
| Frontend e2e (`test:e2e`)                                                                                                                                         | not run: no UI touched                                                                                                                                                |

## Notes for Next Session

1. Merge the feature PR, then a PR flipping feat-062 to `done`
2. Next: feat-063 (resource limits: support chat, multipart) — depends on feat-058 (done)
3. If a role-change feature is ever added, it should call `adminWsChannelService.revokeAdminAccess` for the user's connections on its instance for an immediate effect; the periodic re-check stays the guarantee
