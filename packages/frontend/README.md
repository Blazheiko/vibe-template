# frontend

The `frontend` package is the Vue 3 + Vite single-page application of the
`vibe-template` monorepo. It talks to the [`backend`](../backend) over HTTP and
WebSocket and shares request/response contracts via the [`shared`](../shared)
workspace package.

> Run it from the repository root (`pnpm dev` / `pnpm dev:frontend`). See the
> [root README](../../README.md) for workspace-wide setup, ports, and `.env`.

## Tech stack

- **Vue 3** (Composition API, `<script setup>`) + **TypeScript**
- **Vite** build, with a separate service-worker build (`vite.sw.config.ts`)
- **Pinia** for state management
- **Vue Router** with auth / admin navigation guards
- **vue-i18n** for localization
- **Sentry** (`@sentry/vue`) for error/performance monitoring
- **PWA**: service worker, install prompt, update notifications
- **Playwright** (e2e) and **Vitest** (unit) for testing

## Features

- **Authentication** — login / register (modal-based), email verification, and
  password reset flows (`Login.vue`, `VerifyEmailView.vue`, `ResetPasswordView.vue`)
- **User account** — account settings and avatar editing with image cropping
  (`UserAccount.vue`, `AvatarEditorModal.vue`)
- **Support** — support page backed by a knowledge base (`SupportView.vue`)
- **Admin panel** — knowledge base, users, online users, and online history,
  gated by an admin route guard (`views/admin/*`)
- **Policy pages** — privacy, terms, cookies, and AI/content policy
- **Real-time** — WebSocket connection with a live connection-status indicator
- **Internationalization** — 3 shipped UI locales (`en`, `uk`, `pl`) under
  `src/locales`; the wider `APP_LOCALE_CODES` (18 codes) drive language
  detection and Support AI replies
- **PWA** — installable app with offline-capable service worker and in-app
  update notifications
- **Theming & responsive layout** — light/dark themes, mobile-friendly UI

## Project layout

```
src/
├── components/      # UI components (header, auth modals, menu, admin, …)
├── composables/     # useWebSocketConnection, useSessionLifecycle, useLocale, useModalDialog, …
├── locales/         # vue-i18n message files (en, uk, pl)
├── plugins/         # i18n setup
├── router/          # routes + auth/admin navigation guards
├── stores/          # Pinia stores (user, state, support, push)
├── utils/           # api-client (callApi), ws-client (callWs), api, base-api, csrf-token, ws-event, sentry-*, …
├── views/           # routed pages (auth, account, support, admin, policies)
├── App.vue          # root component
├── main.ts          # app bootstrap (Pinia, router, i18n, Sentry, PWA)
└── service-worker.ts
e2e/                 # Playwright tests
public/              # static assets, manifest, icons
```

## Scripts

Run from the repository root with `pnpm --filter frontend <script>`, or from
this package directory:

| Script            | Description                                               |
| ----------------- | --------------------------------------------------------- |
| `pnpm dev`        | Start the Vite dev server (default http://localhost:5173) |
| `pnpm build`      | Type-check, build the app, then build the service worker  |
| `pnpm preview`    | Preview the production build locally                      |
| `pnpm test:unit`  | Run Vitest unit tests                                     |
| `pnpm test:e2e`   | Run Playwright end-to-end tests                           |
| `pnpm type-check` | Type-check with `vue-tsc`                                 |
| `pnpm lint`       | Lint and auto-fix with ESLint                             |
| `pnpm format`     | Format `src/` with Prettier                               |

## Configuration

Copy `.env.example` to `.env` and set the `VITE_*` variables as needed:

- `VITE_BASE_URL` — API origin; leave empty for same-origin requests (the Vite
  proxy in dev, the backend that serves the SPA in production). Set it only
  when the API lives on another origin (the backend CORS must allow it)
- `VITE_API_PATH_PREFIX` — not set by hand: `vite.config.ts` takes the backend
  `API_PATH_PREFIX` (default `api`) from the shell or `packages/backend/.env`
  and compiles it in; HTTP paths, WS events and the dev proxy key are built from
  it. The dev proxy target follows the backend `HOST`/`PORT` the same way, and a
  different `VITE_API_PATH_PREFIX` in a frontend `.env` fails the config
- `VITE_AUTH_PHONE_ENABLED` — `'true'` enables sign-in and registration by
  phone
- `VITE_SENTRY_DSN` / `VITE_SENTRY_ENABLED` — enable frontend Sentry (disabled
  unless a DSN is set and `VITE_SENTRY_ENABLED` is not `false`)
- `VITE_SENTRY_ENVIRONMENT` / `VITE_SENTRY_RELEASE` — environment and release
  tags; keep `VITE_SENTRY_RELEASE` aligned with the backend `SENTRY_RELEASE`
  for deploy correlation
- `VITE_SENTRY_TRACES_SAMPLE_RATE` /
  `VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE` /
  `VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE` — sampling rates

## CSRF and the session

`src/utils/csrf-token.ts` and `src/utils/base-api.ts` keep the CSRF token in memory and never send a token unless it is known whose session it belongs to:

- A token is **confirmed** together with its owner by `main/init` (200 → its user, 401 → anonymous), by a response that carries `user` (login, register), by logout/logout-all (`sessionAfter: 'anonymous'`), and by a 2xx to a request signed with the confirmed token. Only a confirmed token goes into `X-CSRF-Token`. A token in a 403/401 from the middleware chain stays unconfirmed and is never sent.
- On `403 csrf_invalid` with `reason: token_mismatch` the request asks `main/init` (silently: no events, no redirect) whose session the cookie holds, and repeats **once** with the token from that answer — only if the session still belongs to the user the UI showed when the request was made. `origin_mismatch` and `fetch_site_*` are never repeated.
- Public auth calls pass `csrfRecovery: 'public'` (login, register, password reset, verify-email): they are repeated in an anonymous session. Everything else is `protected`: an anonymous session means `unauthorized` (redirect to login), no repeat.
- If the session belongs to another user (another tab logged in), nothing is sent and the page reloads, so no state of the previous user survives. The error carries `clientCode: 'account_changed'`.
- If `main/init` fails (network, 5xx, no token), the request is not repeated and later mutations are held until a new `main/init` succeeds; meanwhile they fail locally with `clientCode: 'session_unverified'`, no `code`, `transportCode: 0`.
- Concurrent requests share one `main/init`. It times out after 10 s (the session then stays unverified), and a request's `signal` stops its own wait without cancelling the shared refresh.
- A mutation is never signed with a token confirmed for a user other than the one the UI shows: that is an account change (reload), even in the `synced` state.
- After a password change the account page reconnects the WebSocket with the `wsUrl`/`wsToken` from the response (the old socket belonged to the deleted session); with `sessionRenewed: false` it re-reads the session instead.

The service worker (`src/service-worker.ts`, rules in `src/utils/sw-request-policy.ts`) never caches the API: non-GET requests, other origins and everything under `VITE_API_PATH_PREFIX` bypass it, every cache write requires a complete same-origin response without `no-store`/`private`, and activation drops API entries an older worker cached.

`pnpm test:e2e:security` runs the CSRF and service worker scenarios against the production build served by the real backend with enforcement on (needs PostgreSQL and Redis).

## Error monitoring

- `src/utils/sentry-service.ts` is the only module that should import the Sentry
  SDK directly.
- Components and composables should report through `sentryService` (from
  `src/utils/sentry-service.ts`) rather than importing Sentry directly.

## Toolchain notes

- TypeScript is pinned to `6.0.3` and should stay aligned with the workspace
  root. Run `pnpm --filter frontend type-check` (or `pnpm typecheck` from the
  root) before merging dependency changes.
- The production `build` script also builds the service worker via
  `vite.sw.config.ts`; don't skip it when verifying PWA behavior.
