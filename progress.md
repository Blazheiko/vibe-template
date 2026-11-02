# feat-094 — RequestSession Class

Plan: `docs/plan/error-handling-fix-plan.md`, stage 6. Goal: readability; behaviour unchanged.

## Current state

Implemented, awaiting review. Start PR #314 registered feat-094.

## Changes

- `packages/backend/src/vendor/utils/session/request-session.ts` (new): `RequestSession` holds the per-request session state in fields — `info` (current `SessionInfo`), `cookieHeld` (anonymous, only in its cookie), `storageToken` (Redis namespace), `swapped` (login/logout replaced the session here), `preSendCheck` — and changes it only through methods: `restore` (cookie → session, sliding refresh), `attach` (binds to `context.session` / `context.auth`), `login`, `logout`, `logoutAll`, `storeAnonymous`.
- The four module-level `WeakMap`/`WeakSet` keyed by `context` became one `preSendCheck` field with three kinds (`stored-cookie-refresh`, `anonymous-cookie-refresh`, `anonymous-promotion`); the three `beforeSend` overwrites became one `schedule()`; `discardStaleSessionCookie` became a method with one `holdBackCookieIf` helper.
- The duplicated `sessionInfo` (closure variable + `context.session.sessionInfo`) is kept in sync by one `setInfo()`.
- `session-handler.ts`: 534 → 130 lines — reads the cookie (`readIncomingSession`), `sessionHandler` = `RequestSession.restore(...).attach()`, `wsSessionHandler` unchanged.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 1924, frontend 372, api-playground 62, shared 25, documentation 26 passed. All pre-existing session tests passed without edits.
- `test:redis` 88, `test:pg` 153 (local; CSRF bootstrap races, session revocation, logoutAll retry over real Redis/PostgreSQL).
- `pnpm --filter frontend test:e2e`: 81 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- Mutation checks on the new class: dropping the superseded marker on login (3 Redis tests fail), a failed pre-send check keeping the cookie (3 unit tests fail). Two guards had no test before the refactor — the `swapped` guard after an anonymous move to Redis and the id check after the request's own logout; two tests added in `session-before-send.spec.ts`, each fails with its guard removed.
- Manual on a fresh `dist` build: register → logout → wrong password (401) → login → change password (`sessionRenewed: true`) → logout-all → login with the new password; no error records. Test user deleted afterwards.

## Next step

Review + merge, then "Mark feat-094 done". This was the last stage of the error-handling plan.
