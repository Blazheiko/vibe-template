# feat-093 — Remove Compatibility Code

Plan: `docs/plan/error-handling-fix-plan.md`, stage 7. No backward compatibility needed (template in development).

## Current state

Implemented, awaiting review. Start PR #311 registered feat-093.

## Removed

- **Legacy session cookie fallback**: `resolve-session-cookie.ts`, `delete-legacy-session-cookie.ts` (+ specs), the `forceCookie` parameter of `sessionHandler`, `legacyCookieName` in `config/session.ts` (the plain name constant is `PLAIN_COOKIE_NAME` now; `uapi` stays for setups without the `__Host-` prefix). `session_web` reads only `sessionConfig.cookieName`.
- **`LegacyLoginInputSchema`**: login takes `identifier` only (`resolveLoginIdentifier` gone). Frontend and api-playground already sent `identifier`; tests updated.
- **`routeItem`** type alias.
- Frontend: the one-time `uiLang` localStorage migration in `useLocale` (+ its test); the unused raw `ws` export of `useWebSocketConnection` (frontend and api-playground); a misleading "for compatibility" comment on `websocketApi`.
- api-playground: `LEGACY_BASE_URL` (an empty string duplicating the empty check).

## Kept on purpose

- `fields` in `serialize-ark-schema.ts`: the current format the api-playground UI reads, not a compatibility layer for old clients.
- `legacy: false` in vue-i18n: a library option.
- `code` in `WebsocketMessage`: shared with the HTTP error normalizer; untangling it is outside this stage.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 1922, frontend 372, api-playground 62, shared 25, documentation 26 passed.
- `pnpm --filter frontend test:e2e`: 81 passed.
- `test:redis` 88 (one legacy-cookie test removed), `test:pg` 153 (local).
- `pnpm docs:build && pnpm docs:verify` passed.
- New tests: `session_web` hands the handler only the active cookie and ignores other names.
- Manual on a fresh `dist` build: login with `{ email, password }` → 422 `validation_failed`; with `{ identifier, password }` → 200. Test user deleted afterwards.

## Next step

Review + merge, then "Mark feat-093 done". Remaining plan stage: 6 (session state class).
