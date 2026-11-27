# feat-272 · Branded Types Session And Deadline Gaps

Branch: `fix/branded-types-session-gaps`. Status: implementation done, PR open.

## Changes

1. **Session token check.** `checkSessionToken(userId: UserId, userToken: SessionToken)`; the session layer hook is `checkSessionTokenText(text, text)` (registered in `app/start`), which parses once (`parseUserId`, a non-row id is `mismatch` without a lookup). `ws-session-auth` passes `ownerId` / `sessionTokenOf(userToken)`. New `SessionId` brand (`sessionIdOf`, T30) for `wsSessionRevocation.isSessionStored` and the `sessionId` / `exceptSessionId` options of `closeUserConnections`; every app caller brands the id where it reads it. Type tests in `secret-brands.spec.ts` (swapped arguments, bare text).
2. **Session TTL.** `redis-ttl.ts` moved to `vendor/utils/redis/` (both layers import it), with `setIfAbsentWithTtlSeconds` (SET EX NX) and `getAndRenewTtlSeconds` (GETEX EX). `storedSessionTtl(): Seconds`; `redis-session-storage` (saveSession, getSession, the cookie refresh / superseded markers, the Lua ARGV) and `session-index` go through the helpers; `COOKIE_REFRESH_SECONDS` / `ANON_COOKIE_REFRESH_SECONDS` are `Seconds`. The ESLint rule against raw `setex` / `getex` / `set EX|PX` covers the whole backend (`vendor/` included). `config/session.ts` rounds durations up (`toSecondsCeil`); a `SESSION_ANON_TTL` under one second is still refused (checked in ms). `redis-main.redis.test.ts` waits for `set` instead of `setex`. Type tests in `time-brands.spec.ts`, real TTL tests for the two new helpers in `redis-ttl.redis.test.ts`.
3. **toEntityId** takes `RowId` (the union of the bigint id brands); `0n`, `-1n`, `2n ** 63n` do not compile (test in `shared-brands.spec.ts`). Tutorial (both locales) and `backend-feature` skill: a new id brand joins `RowId`.
4. **Admin WS channel deadline.** `StaffMfaPolicy.sessionDeadline` / `staffSessionOk` take and give `UnixMs` (`addMs`); `staffSessionDeadline(): UnixMs | null` with `NO_STAFF_DEADLINE` named instead of `Number.POSITIVE_INFINITY`; `adminChannelSubscribers` stores `UnixMs` and `dropExpired(nowMs: UnixMs)`; the broadcast service passes `nowUnixMs()`; the timer uses `diffMs`. Type tests in `time-brands.spec.ts`.

Docs: `backend/repositories.md`, `backend/adding-a-feature.md` (both locales), `.claude/skills/backend-feature/SKILL.md`.

## Evidence of Completion

- `make check`: exit 0 (backend 3929, frontend 1029, landing 103, api-playground 115, rule tests 30; one pre-existing frontend lint warning).
- `REDIS_TEST_URL=redis://127.0.0.1:6379/15 pnpm --filter backend test:redis`: 22 files; 2 failures in `redis-main.redis.test.ts` (it waited for `setex`, saveSession now sends `SET … EX`) fixed, file then 13/13; the other 21 files passed (229 tests in the full run before the fix).
- `pnpm docs:build && pnpm docs:verify`: all checks passed.
- PG suite: CI `test-pg` of the PR.

## Review round 2 (2026-11-27, COMMENT, no blockers)

Fixed on this branch:

- **TTL in the session layer (item 1).** `prepareLogin` / `preparePendingSession` take `Seconds` (`types.d.ts`, `request-session`, `session-index`, the MFA second step keeps the ticket's `Seconds` TTL); `secondsArg` for `PENDING_PREPARE_LUA`; the absolute session age is `sessionMaxAge(): Seconds` with `toMs` / `secondsArg` in `createIndexedSession` and `activatePendingSession` (no `* 1000`); `SlidingLogOptions.windowMs: Milliseconds` with `msArg`.
- **ws-coordinator (item 2).** A user id that is not a row id is logged and the socket closed (`endSessionExpired`), never left open unregistered (lifecycle test, fails without the fix); the session token is compared as the branded `userToken`.
- **asUserId at session boundaries (item 4).** `parseUserId` in `mainService.init` (a non-row id is `unauthorized('Session expired')`), `authService.logoutAll` / logout push release, and the WS support controller.
- **Docs (item 6).** `backend/database.md` (both locales): the runtime import of `newSessionToken`, every table branded.
- **Nits.** JSDoc of `RowId` / `toEntityId` in `app/domain/ids.ts`; the JSDoc cast in `no-brand-cast.mjs` is on `type`; `otpCodeMatches` compares the decoded buffers (a 64-char non-hex stored value is no match, not a `RangeError`; test fails without the fix).

Not in feat-272 scope (proposed as a follow-up): item 3 (`closeUserConnections(userId: string)` and `SessionId` in `ws-connection-registry`), item 5 (`newSmsChallengeId()` instead of `nanoid()` in `schema.ts`), item 7 (`* 1000` in `webauthn-ceremony`, `shared/mfa/session-auth.ts` on `UnixMs`, the cookie `maxAge` of `request-session`).

Evidence: affected Redis tests (`REDIS_TEST_URL=redis://127.0.0.1:6379/15`, rate-limit, session, shared, websocket, auth): 10 files, 115 passed; `pnpm docs:build && pnpm docs:verify` passed; `make check` exit 0 (backend 3933, frontend 1029, rule tests 30).
