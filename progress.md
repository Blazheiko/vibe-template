# feat-141 — Web Routes vs Public API Docs

## State

Done on branch `docs/feat-141-web-vs-api-routes`. Waiting for CI on the feature PR.

## Changes

- New page `documentation/backend/web-and-api-routes.md` ("Веб-маршрути і публічний API"): the
  two kinds of HTTP routes; why CSRF concerns only cookie-authenticated routes; what
  `session_web` and `csrf_guard` do and cost; how to declare a web group and a public API group
  (own prefix, `rateLimit`, no cookies, credentials from a header); what a handler gets without
  `session_web`; API authentication (`auth_guard` reads only the cookie session; an API-key
  middleware sketch under `::: warning План`, not implemented); CORS for browser clients; why a
  public route cannot sit in a web group (group middlewares are concatenated, no opt-out) and
  what the client then gets; what breaks the other way round; decision flowchart, checklist;
  backend-only mode (`CSRF_ALLOWED_ORIGINS` still required in production-like environments).
- Sidebar (`.vitepress/config.ts`) and `KEY_PAGES` (`scripts/verify-dist.mjs`).
- Links to the page from `backend/middlewares.md`, `backend/routing.md`, `backend/security.md`,
  `guide/csrf.md`.
- New test `packages/backend/src/app/routes/web-and-api-routes.spec.ts` pins the page: in
  `http-routes.ts` every route with `session_web` has `csrf_guard` right after it, every
  unsafe-method route has `csrf_guard`, only `GET /api/ping` and `GET /api/ready` are outside web
  groups; group middlewares come first and cannot be dropped; without `session_web` the context
  has no session/user, `auth_guard` → 401 even with `Authorization`, `csrf_guard` → 403
  `token_mismatch` on POST, GET passes; a server-to-server POST on a web route → 403
  `origin_mismatch`.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean
- `pnpm --filter backend test`: 192 files, 2555 tests passed
- `pnpm docs:build && pnpm docs:verify`: all checks passed
- Mutation: removing `csrf_guard` from the `main` group makes the new spec fail
  (`every route with session_web also has csrf_guard right after it`); restored → 11/11 pass.
- Code facts checked against `session-web.ts`, `csrf-guard.ts`, `auth-guard.ts`,
  `http-context.ts`, `router.ts`, `request-session.ts`, `config/cors.ts`,
  `validate-runtime-config.ts`.
