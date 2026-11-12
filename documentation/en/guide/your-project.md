# Your project on the template

This page is about turning the template into **your** product: what to rename, where to change the interface, how to add your own domain and what to do with integrations you do not need. How the workflow in the template repository itself works (`feature_list.json`, branches, Definition of Done) is described separately in [Workflow](/en/guide/workflow).

::: info Before reading

- The project is running and you have gone through the [first scenario](/en/guide/getting-started#_6-first-scenario-from-login-to-logout).
- You have gone through [First route](/en/guide/first-endpoint), and preferably [How to add a feature](/en/backend/adding-a-feature) too.

:::

## What is already there: a gallery

Before deleting or rewriting anything, look at what you get right away. All screenshots were taken on a clean run with demo accounts (`db:seed --demo`).

**Sign-in and registration.** Email and password, social sign-in buttons (only for the providers configured on the backend: Google, GitHub, GitLab, Facebook), password reset. Behind them are the `/api/auth/*` and `/api/auth/oauth/*` routes.

![Sign-in form](/screenshots/login.jpg)

**Account.** Password change, phone and email linking, theme, font size, color schemes. The avatar is uploaded to S3.

![Account page](/screenshots/account.jpg)

**Admin: users.** A list with a filter by id and registration date (`GET /api/admin/users`), available only to the `admin` role. The list is paged: the response carries `total`, `hasMore` and `nextCursor` (the id of the last user of the page), and the next page is the same request with `cursor=<nextCursor>`. A page holds up to 200 rows (`limit`, 50 by default; the admin UI asks for 100), newest registrations first. The connection history (`GET /api/admin/history-online`) works the same way.

![Admin: users](/screenshots/admin-users.jpg)

**Admin: who is online.** Updated in real time via WebSocket: when someone signs in, the row appears without a reload.

![Admin: online users](/screenshots/admin-online.jpg)

**Admin: knowledge base.** Articles for the AI support chat, reindexing, initial population.

![Admin: knowledge base](/screenshots/admin-knowledge-base.jpg)

**Support chat.** The AI answers based on the knowledge base, and the reply arrives in chunks over WebSocket. Requires `OPENAI_API_KEY` (without it the button shows `Failed to open support chat`).

![Support chat](/screenshots/support.jpg)

To call any HTTP or WS route by hand there is a separate application, [API Playground](/en/playground/).

## 1. Rename

The template name is hard-coded in several places. Below is the list collected by searching for `Vibe Template`, `VIBE` and `vibe-template` across `packages/` (excluding tests and `node_modules`):

| What                                        | Where                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Workspace name                              | `package.json` (`"name": "vibe-template"`)                                                          |
| Page title and description                  | `packages/frontend/index.html` (`<title>`, `meta`)                                                  |
| PWA: name, icons, colors                    | `packages/frontend/public/manifest.json`, `public/icons/`, `public/splash/`, `public/favicon.svg`   |
| Logo on the sign-in page                    | `packages/frontend/src/views/Login.vue` (`'VIBE'`), `src/assets/logo.svg`                           |
| Name in the PWA install button              | `packages/frontend/src/components/MenuButton.vue`                                                   |
| Home page texts                             | `packages/frontend/src/locales/*.ts` (`heroTitle`, `mobileTitle`, etc.)                             |
| Service worker cache                        | `packages/frontend/src/service-worker.ts` (`__vibe_template_sw_error_queue__`)                      |
| Emails (password reset, email confirmation) | `packages/backend/src/app/services/auth/password-reset-service.ts`, `email-verification-service.ts` |
| AI support prompts                          | `packages/backend/src/config/support.ts`; `db:seed` puts them into the database                     |
| Default DB name                             | `packages/backend/src/config/database.ts` (`vibe_template`)                                         |
| `robots.txt`                                | `packages/frontend/public/robots.txt`                                                               |

In `.env`, change:

| Variable                            | Value in `.env.example`    | Why                                                            |
| ----------------------------------- | -------------------------- | -------------------------------------------------------------- |
| `APP_NAME`                          | `uwebsockets-api`          | Application name in logs and configuration                     |
| `REDIS_PREFIX`                      | `uwebsocket:`              | Redis key prefix; different projects on one Redis will not mix |
| `PGSQL_DB_NAME`                     | `vibe_template`            | Your own database                                              |
| `SMTP_FROM_NAME`, `SMTP_FROM_EMAIL` | —                          | Who the emails come from                                       |
| `VAPID_SUBJECT`                     | `mailto:example@gmail.com` | Contact for browser push services                              |

AI prompts are cached in the database: if you have already run `db:seed`, change them in the admin panel or rerun the seed on a clean database.

::: warning Legal pages
`PrivacyPolicy.vue`, `TermsAndConditions.vue`, `CookiesPolicy.vue` and `AiPolicy.vue` in `packages/frontend/src/views/` contain the template's texts. Before publishing, replace them with your own, agreed with a lawyer.
:::

## 2. Change the interface

| What to change               | Where                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Colors, base styles          | `packages/frontend/src/assets/base.css`, `main.css` (CSS variables `--color-*`)                                             |
| Pages                        | `packages/frontend/src/views/`                                                                                              |
| Frontend routes and access   | `packages/frontend/src/router/index.ts` (guard for signed-in users and admins)                                              |
| Header, menu, sign-in modals | `packages/frontend/src/components/` (`AppHeader`, `MenuButton`, `AuthModals`)                                               |
| Texts and languages          | `packages/frontend/src/locales/` (`en`, `uk`, `pl`; a new language is added with a file and code in `SHIPPED_LOCALE_CODES`) |

Details are on the [Frontend](/en/frontend/) page.

## 3. Add your own domain

The template does not impose a subject area: the "notes" in the tutorial are just an example. For your own resource:

1. **Backend.** Follow the steps in [How to add a feature](/en/backend/adding-a-feature): schemas in `shared` → table and migration → repository → transformer → service → controller → route.
2. **Frontend.** Add a page in `src/views/`, a route in `src/router/index.ts` and a method in `src/utils/api.ts`. Import request and response types from `shared/schemas` and `shared/responses`, then a contract change on the backend will light up the frontend at `pnpm typecheck` (see the [example](/en/#what-it-looks-like-in-practice)).
3. **Real-time, if needed.** An event from the server — [WebSocket: send an event](/en/backend/websocket#in-brief-by-example-send-an-event-from-the-server).

## 4. Choose integrations

Each integration is enabled with environment variables. Without them the server starts, and the corresponding feature returns an error. What exactly happens without each service is shown in the table [What is needed now and what can be set up later](/en/guide/getting-started#what-you-need-now-and-what-you-can-configure-later).

There are three levels of decision:

| Decision             | What to do                                                                                                                                                  | When                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Configure**        | Fill in the variables in `.env` following [Configuration](/en/backend/configuration)                                                                        | The feature is needed                                     |
| **Leave disabled**   | Do nothing. Hide the buttons in the interface (for example, the "Support" menu item). Social sign-in buttons hide themselves until a provider is configured | You may need it later                                     |
| **Remove from code** | Remove the feature's routes, controllers, services, pages and tests (see below)                                                                             | Definitely not needed, and you want less code to maintain |

### How to remove a feature

Remove from the outer layers to the inner ones, so that TypeScript tells you what else depends on the removed code:

1. Pages and menu items in the frontend, routes in `src/router/index.ts`.
2. The route group in `packages/backend/src/app/routes/http-routes.ts` (and `ws-routes.ts`, if there are WS routes). For example, AI support consists of the groups with `prefix: 'support'` and `prefix: 'prompts'`, the admin knowledge base routes and the WS routes `support_open_chat`, `support_chat`.
3. The feature's controllers, services, repositories and transformers, together with their `*.spec.ts`.
4. Tables: remove them from `schema.ts` and generate a migration (`db:generate`). The pgvector extension is needed as long as the schema has a `vector` column.
5. Variables from `.env.example` and checks from `validate-runtime-config.ts`.

After each step, run:

```bash
pnpm typecheck && pnpm lint && pnpm test
```

`pnpm typecheck` will show imports of removed modules, and `layering.spec.ts` in `pnpm test` will verify that the layers have not started calling each other bypassing the rules.

### API only, no frontend

If you only need the backend (a mobile app, integrations), you can remove the `frontend` package and use [API Playground](/en/playground/) for manual API checks. More in the [Introduction](/en/guide/introduction#who-it-is-for).

## 5. Before the first deploy

- Go through the [production checklist](/en/backend/security#production-checklist): in particular `CSRF_ALLOWED_ORIGINS` (without it the production server will not start) and a strong `APP_KEY`.
- `DOMAIN` is your domain (without a port if it is 443), then `wsUrl` will be `wss://<domain>/api/websocket`.
- Build and run instructions: [Deployment](/en/backend/deployment).

::: tip Next step
[Deployment](/en/backend/deployment): build, Docker image, healthcheck and running behind a proxy.
:::
