---
layout: home

hero:
    name: vibe-template
    text: Full-stack TypeScript template
    tagline: A ready-made template for a quick start on development of applications with AI agents. Strict typing, checks and working rules keep the agent in bounds, so it makes fewer mistakes and sees its own mistakes itself.
    image:
        src: /logo.svg
        alt: vibe-template
    actions:
        - theme: brand
          text: Get started
          link: /en/guide/getting-started
        - theme: alt
          text: How the backend works
          link: /en/guide/how-backend-works
        - theme: alt
          text: GitHub
          link: https://github.com/Blazheiko/vibe-template

features:
    - icon: 🔐
      title: Accounts and sign-in
      details: Registration by email and phone, email confirmation, sign-in via Google, GitHub and Facebook, password reset, sign-out from all devices.
      link: /en/backend/auth
    - icon: ⚡
      title: Fast backend on uWebSockets.js
      details: HTTP and WebSocket in one process. The code is laid out in layers route → controller → service → repository, so it is clear where to write what.
      link: /en/backend/architecture
    - icon: 🛡️
      title: Security out of the box
      details: Sessions in Redis, CSRF, CORS, CSP and security headers, rate limiting, brute-force protection, trusted proxies.
      link: /en/backend/security
    - icon: 🔄
      title: Real-time
      details: An authorized WebSocket channel, who is online, online history, push from server to client.
      link: /en/backend/websocket
    - icon: 🔔
      title: Web Push notifications
      details: Browser push subscription, subscription storage and sending via VAPID are already built in. One command, pnpm push:vapid, generates the keys.
      link: /en/backend/web-push-notification
    - icon: 📱
      title: PWA installation
      details: The app installs on a phone and a computer like a native one. It has a manifest, icons, a splash screen, a Service Worker with an offline cache and a new-version notification.
      link: /en/frontend/#pwa
    - icon: 🤝
      title: Shared contracts
      details: The shared package with arktype schemas, enums and response types. If you change a shared type, TypeScript shows where the frontend and backend have diverged.
      link: /en/shared/
    - icon: 🛠️
      title: Admin panel
      details: A list of users, who is online now, online history and a knowledge base editor for the AI chat. A separate layout and access for administrators only.
      link: /en/frontend/
    - icon: 🌍
      title: 18 languages and themes
      details: The interface is translated with vue-i18n into 18 languages. Light and dark themes and the Ocean, Mint, Lavender, Rose, Sunset and Monochrome color palettes.
      link: /en/frontend/#i18n
    - icon: 📁
      title: Files and mail
      details: Uploading files to any S3-compatible storage (AWS, MinIO, DigitalOcean Spaces). SMTP emails for email confirmation and password reset.
      link: /en/backend/storage
    - icon: 🧪
      title: API Playground
      details: A separate app for local development that shows all the backend's HTTP and WebSocket routes and lets you call them manually.
      link: /en/playground/
    - icon: 🤖
      title: AI support chat
      details: A chat that answers from a knowledge base (pgvector), a prompt admin panel, token accounting, OpenAI, xAI and Mistral providers.
      link: /en/backend/ai
---

## What this template is

**vibe-template** is a ready-made template for a quick start on development of applications **with AI agents** (Claude Code, Codex, Cursor and others). An agent writes code fast, but it can just as fast write code that only looks correct. The template keeps the agent in a strictly typed environment: the compiler, the linter and the architecture tests catch most of such mistakes right away, and the agent fixes them itself, before the code reaches you for review. Why this works is covered in the section [Why the template suits agent-based development](#why-the-template-suits-agent-based-development).

This is not an empty "skeleton" but a **working application** from which you start your product. The first weeks of a new project usually go to the same things: registration, login, password reset, sessions, CSRF, file uploads, emails, push, an admin panel, deployment. In this template all of that is already written, covered by tests and documented. You clone the repository, configure `.env` and immediately write **your own** business logic.

The template consists of three packages in one repository (pnpm workspace):

| Package    | What it is                                                                   | Documentation                     |
| ---------- | ---------------------------------------------------------------------------- | --------------------------------- |
| `backend`  | API server and WebSocket in TypeScript + uWebSockets.js                      | [Backend overview](/en/backend/)  |
| `frontend` | SPA/PWA on Vue 3 with Pinia, vue-router and vue-i18n                         | [Frontend](/en/frontend/)         |
| `shared`   | Schemas, types and enums that both the frontend and the backend import alike | [The shared package](/en/shared/) |

::: tip New to the project?
Start with the [Introduction](/en/guide/introduction), then the [Quick start](/en/guide/getting-started) — a local launch in 10 minutes. Then read [How the backend works](/en/guide/how-backend-works): it explains in simple words what happens to a request and why each layer exists.
:::

## How the developer's role changes

The template moves control from the code to the **contracts**. The agent writes the implementation and immediately gets feedback from the framework: whether the contracts are broken, whether the layers are in place, whether the tests pass. So you do not need to read every line of generated code. The main attention goes to three contracts:

1. **What comes into the backend.** The request schemas in `shared` define what data a route accepts. A `validator` on a route is optional: a route without one accepts any body, so check that it is there wherever the route reads input.
2. **What the backend returns.** A route with a `ResponseSchema` checks each of its responses (how exactly — [argument 5](#why-the-template-suits-agent-based-development) below).
3. **The database schema.** The Drizzle schema and migrations define the data structure that everything else depends on.

The three contracts do not describe **access to routes**: which middleware, guards and limits a group or a route has is in `http-routes.ts` and `ws-routes.ts`, and part of the rules is checked by `route-access.spec.ts`. These files need attention in review too.

The correctness of business logic is verified by **tests**: if a behavior is described by a test and the test is green, review can focus on the tests and the contracts rather than on every line of the implementation. Human review stays required ([`AGENTS.md`](https://github.com/Blazheiko/vibe-template/blob/main/AGENTS.md), Definition of Done), and a change to tests needs review just as a change to code does: a weakened test lets through what it was meant to catch.

## Why the template suits agent-based development

**Thesis.** An agent works best where a mistake is visible immediately and unambiguously. A human notices a mismatch from experience, while an agent only notices it from what the compiler, the linter and the tests return. So the stricter the automatic checks, the fewer agent mistakes reach the human. The template is built exactly that way: most typical agent mistakes here turn into a red `pnpm typecheck`, `pnpm lint` or `pnpm test`, and the agent fixes them in the same loop.

**Arguments.**

1. **A strict compiler does not allow "guessing".** The backend and `shared` are built from [`tsconfig.base.json`](https://github.com/Blazheiko/vibe-template/blob/main/tsconfig.base.json), where besides `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` and `noImplicitReturns` are enabled. Accessing an array element that may be missing, or a field that is not in the type, is a compile error, not `undefined` in production. The frontend is checked by `vue-tsc` in `strict` mode.
2. **The linter closes the workarounds.** [`eslint.config.ts`](https://github.com/Blazheiko/vibe-template/blob/main/eslint.config.ts) enables `strictTypeChecked`, forbids `any` and all `no-unsafe-*` operations, and requires explicit return types, `strict-boolean-expressions` and `switch-exhaustiveness-check`. The agent cannot "silence" a type through `any`, and after adding a new enum value it gets an error in every `switch` that does not handle it.
3. **One contract for both sides.** API schemas are described once with arktype in the `shared` package, the DB structure once with a Drizzle schema. When the agent changes a contract, `pnpm typecheck` shows all the places in the backend and frontend that need updating (an example is [below](#changed-the-contract-—-typescript-showed-what-broke)). The agent does not have to remember who else uses the type: the compiler provides the list.
4. **Architecture is checked by tests, not by agreement.** [`layering.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/layering.spec.ts) fails if a controller imports a repository directly or a service goes to the DB bypassing the repository. [`route-access.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/route-access.spec.ts) checks that the admin and push routes have guards and that the response schemas describe the real JSON. An agent that cut a corner learns about it from a test.
5. **Server responses are validated at runtime.** A route with a `ResponseSchema` checks every response against this schema, and the schema works as an allow-list of fields. In development, CI and e2e the `strict` mode applies: if the agent forgot a field, got a type wrong or accidentally returned an extra field (for example, a password hash from a DB row), the request fails with `500` and an error in the log. In production `log` applies by default: extra fields are stripped, and a mismatch with the schema still gives `500`. The mode is set by `RESPONSE_VALIDATION_CONTRACT`; the validation cannot be turned off. More in [Response validation](/en/backend/response-validation).
6. **The same structure means less context.** Every backend feature consists of the same layers route → controller → service → repository. The agent does not have to read the whole project: it is enough to open a neighboring feature as a sample.
7. **One command to check everything.** [`init.sh`](https://github.com/Blazheiko/vibe-template/blob/main/init.sh) runs install, typecheck, lint, test and build. CI runs the same checks (plus `format:check` and Playwright) on every PR, so the agent's "it works for me" is verified the same way as a human's code.
8. **The working rules are written for the agent.** [`AGENTS.md`](https://github.com/Blazheiko/vibe-template/blob/main/AGENTS.md) describes the session start order, the Definition of Done and the documentation rules. `feature_list.json` records who works on which feature, and `progress.md` and `session-handoff.md` on the feature branch carry the state between sessions. The agent starts a new session from files, not from the memory of the previous conversation. More in [Workflow](/en/guide/workflow).

::: warning What types do not guarantee
The checks catch errors of form: wrong types, forgotten usage sites, broken layers. They do not verify that the business logic is correct. For that you need behavior tests. A test checks only the cases it describes, so in review a human checks that the needed cases are described and the existing ones are not weakened.
:::

## Why this template

- **No need to write the foundation.** Authentication, security, mail, files, push, the admin panel and AI already work. That is thousands of lines of code you do not write or debug.
- **Performance.** uWebSockets.js is one of the fastest HTTP/WebSocket servers for Node.js according to [public benchmarks](https://github.com/uNetworking/uWebSockets/tree/master/benchmarks) (there are no own measurements for the template). Real-time does not need a separate service.
- **A single source of truth instead of duplicated types.** The API contract is described once with an arktype schema in the `shared` package: the backend uses it to validate the request and the response at runtime, and the type is inferred (`typeof Schema.infer`) and imported by both the backend and the frontend. The DB structure is described once with a Drizzle schema: migrations are generated from it and row types are inferred (`InferSelectModel`). Change the schema and `pnpm typecheck` shows all the places on the server and the client that need updating. How it works — [Where types come from](/en/guide/how-backend-works#where-types-come-from-a-single-source-of-truth).
- **Predictable structure.** Every feature consists of the same layers. Knowing one, you find your way around all of them. The layer rules are checked by a test, so the architecture does not "drift" over time.
- **Safe defaults.** Most protections (CSP, security headers, rate limiting, HttpOnly cookies) are on from the start, and the server does not start with some unsafe settings (the `validateRuntimeConfig` check). The exception is CSRF: by default it only logs violations, and for production you need to enable `CSRF_ENFORCE=true`.
- **PWA and push right away.** The app can be installed on a device from the menu, and the server can send Web Push even when the tab is closed. For push you only need VAPID keys in `.env`.
- **Production-ready.** Pino logs, Sentry, the `/ready` health check, graceful shutdown, a Dockerfile with a healthcheck, configuration via env. How to build and run — [Deployment](/en/backend/deployment).
- **Tests out of the box.** More than a thousand unit and integration tests on Vitest. Tests with PostgreSQL create a separate temporary database for themselves, and Playwright checks the frontend in a browser. More in [Testing](/en/backend/testing).
- **Examples of legal pages.** Privacy Policy, Terms, Cookies Policy and AI Policy already have routes and pages in the frontend. This is an **example placeholder**, not a ready legal text: replace the content with your own and agree it with a lawyer before launch.

## What it looks like in practice

Three examples from the template code showing what these advantages give you when you change the product.

### Changed the contract — TypeScript showed what broke

The user list in the admin panel is described by one schema in `shared` ([admin-user-controller.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/responses/admin-user-controller.ts)). The type is inferred from it, not written separately:

```ts
export const AdminUserListItemSchema = type({
    id: 'string',
    name: 'string', // we will rename it to fullName
    email: 'string',
    registeredAt: 'string',
})
export type AdminUserListItem = typeof AdminUserListItemSchema.infer
```

After renaming `name` → `fullName`, TypeScript shows both sides:

```text
packages/backend typecheck: src/app/controllers/http/admin/admin-user-controller.ts(29,37):
  error TS2322: Type 'AdminUserListItem[]' is not assignable to type
  '{ id: string; fullName: string; email: string; registeredAt: string; }[]'.
src/views/admin/AdminUsersView.vue(165,37): error TS2339: Property 'name' does not exist on type
  '{ id: string; fullName: string; email: string; registeredAt: string; }'.
```

`pnpm typecheck` stops at the first package with an error, so the frontend error is visible after you fix the backend or in `pnpm --filter frontend typecheck`.

Without a shared type, the backend would start returning the new field, and the table in the admin panel would silently show an empty column. The same schema describes the response of the `GET /api/admin/users` route in the [API Playground](/en/playground/), so the API documentation does not diverge from the type either.

::: warning Limitation
Protection by types works only where both sides really import the type from `shared`. Response validation against `ResponseSchema` ([argument 5](#why-the-template-suits-agent-based-development)) protects the server, but the frontend is not protected by this: if a component described its own type instead of importing it from `shared`, only the user will see the mismatch. New code is best written as in the example above: a schema in `shared`, a type via `.infer`, and this type in the service, the controller and the component.
:::

### One service for HTTP and WebSocket

The support chat works over two transports: messages go over WebSocket ([ws/support-controller.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/controllers/ws/support-controller.ts)), and the chat history is loaded over HTTP ([http/support/support-controller.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/controllers/http/support/support-controller.ts)). Both controllers are thin and call the same `supportService`:

```ts
// WebSocket: a new message in the chat
void supportService.chat(BigInt(userData.userId), payload.message, userData.uuid, context.signal)

// HTTP: chat history
const result = await supportService.getChatHistory(userId)
```

The chat rules (limits, history storage, calls to AI) live in one place. If you change them, the behavior of both transports changes.

### Testing business logic without a database

A service gets data only through a repository, so in a test the repository is easy to replace. A fragment from [avatar-service.spec.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/avatar-service.spec.ts):

```ts
const userRepositoryMock = { findById: vi.fn(), update: vi.fn() }

vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
}))

userRepositoryMock.findById.mockResolvedValue({ id: 7n, name: 'Alice', avatar: null })
const result = await avatarService.uploadAvatar(7n, file)
expect(Result.isOk(result)).toBe(true)
```

The test checks the avatar upload logic in milliseconds, without PostgreSQL, Redis and S3.

## What is already implemented

Below is the functionality you can use right away. The API prefix by default is `/api` (`appConfig.pathPrefix`).

### Authentication and account

| Capability                        | How it works                                                                   | More details                                               |
| --------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Registration by email             | `POST /auth/register/email`, an email with a confirmation link                 | [Authentication](/en/backend/auth#sign-in-methods)         |
| Email confirmation                | `POST /auth/verify-email`, resend via `resend-verification-email`              | [Mail](/en/backend/mail)                                   |
| Registration and sign-in by phone | SMS code: `register/phone/start` → `confirm` → `complete-profile`              | [Authentication](/en/backend/auth#sign-in-methods)         |
| Social login (OAuth)              | Google, GitHub, Facebook: `auth/oauth/:provider/redirect` and `/callback`      | [Authentication](/en/backend/auth#sign-in-methods)         |
| Login / logout                    | `POST /auth/login`, `/logout`, `/logout-all` (sign out on all devices)         | [Authentication](/en/backend/auth)                         |
| Password change and reset         | `change-password`, `forgot-password` → email → `reset-password`; reset via SMS | [Authentication](/en/backend/auth)                         |
| Linking a phone / email           | `link-phone/start`, `link-phone/confirm`, `link-email/start`                   | [Authentication](/en/backend/auth)                         |
| User avatar                       | `POST /avatar/upload` (S3/MinIO), `DELETE /avatar`                             | [File storage](/en/backend/storage)                        |
| Roles                             | A regular user and an administrator, the `auth_guard` and `admin_guard` guards | [Roles and capabilities](/en/reference/roles-capabilities) |

### Security

| Capability               | What it gives                                                                        | More details                                                     |
| ------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Sessions in Redis        | HttpOnly cookie with an HMAC signature, token rotation, instant session revocation   | [Sessions](/en/backend/auth#sessions)                            |
| CSRF protection          | A token for all requests that change data                                            | [CSRF](/en/backend/security#csrf)                                |
| CORS                     | A whitelist of allowed domains                                                       | [CORS](/en/backend/security#cors)                                |
| CSP and security headers | Content-Security-Policy, `X-Frame-Options` and other headers on every response       | [Headers](/en/backend/security#security-headers-and-csp)         |
| Rate limiting            | Global and per-route limits, in memory or shared via Redis                           | [Limits](/en/backend/security#rate-limiting)                     |
| Brute-force protection   | Throttling of login attempts, OTP codes and password reset                           | [Login policy](/en/backend/security#login-policy)                |
| Trust proxy              | The correct client IP behind nginx / a load balancer                                 | [Trust proxy](/en/backend/security#trust-proxy-and-ip-detection) |
| Input validation         | Every route describes an arktype schema; an invalid request will not reach your code | [Validation](/en/backend/validation)                             |

### Real-time (WebSocket)

- One WebSocket connection per client, authorized with a short token (`GET /main/update-ws-token`).
- A custom message protocol and a WS route dispatcher, with routes described the same way as HTTP routes.
- Tracking who is online and the online activity history (for the admin panel).
- Broadcasting events from the server to a specific user or channel (`broadcast-service`).
- Heartbeat and timeouts so that "dead" connections close by themselves.

More details: [WebSocket](/en/backend/websocket).

### Notifications and mail

- **Transactional emails** via SMTP (nodemailer): email confirmation, password reset. There is a `send-test-email` script for checking the settings.
- **Web Push** (VAPID): subscription, update, deactivation, test sending, a delivery log and statistics for each subscription (`/push-subscriptions/*`).

More details: [Mail](/en/backend/mail) and [Web Push notifications](/en/backend/web-push-notification).

### Files

- Uploading to S3-compatible storage (AWS S3, MinIO and others), presigned links.
- A ready example of use — avatars and knowledge base article screenshots.

More details: [File storage (S3)](/en/backend/storage).

### AI

- **Support chat (Support AI):** answers the user's questions based on the knowledge base. Search for relevant articles via embeddings in PostgreSQL (pgvector), a streamed response over WebSocket, chat history.
- **Knowledge base:** CRUD for articles, screenshots, reindexing one article or all of them, initial population.
- **Prompts in the DB:** system prompts are edited from the admin panel without a deploy, and they can be tested before saving.
- **Token accounting:** AI usage statistics.
- **Multiple providers:** OpenAI, xAI (Grok), Mistral. The provider is chosen by the `AI_TEXT_DRIVER` variable or by the model name in the prompt.

More details: [AI integrations](/en/backend/ai).

### Admin panel

- A list of users.
- Who is online now (updated in real time via WebSocket) and online history.
- Management of the knowledge base and AI prompts, AI usage statistics.

Access only for the administrator role — [Roles and capabilities](/en/reference/roles-capabilities).

### Frontend

- Vue 3 + Pinia + vue-router, route guards for authorized and admin pages.
- Ready pages: login/registration, email confirmation, password reset, account, support chat, admin panel, legal pages (Privacy, Terms, Cookies, AI Policy).
- **18 languages** of the interface (vue-i18n), including Ukrainian and English.
- **PWA:** installation on a device, offline mode, push notifications.
- An HTTP client that adds the CSRF token itself and handles the session; a WebSocket client with reconnection.
- Unit tests (Vitest) and e2e (Playwright).

More details: [Frontend](/en/frontend/).

### Infrastructure and quality

| Capability      | What there is                                                                                              | More details                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Database        | PostgreSQL + Drizzle ORM, migrations, seed, a database creation script                                     | [Database](/en/backend/database)             |
| Configuration   | Everything via environment variables, configuration validation at startup                                  | [Configuration](/en/backend/configuration)   |
| Logs and errors | Pino (structured logs), Sentry on the backend and the frontend                                             | [Observability](/en/backend/observability)   |
| Health check    | `GET /ping` (the process is alive), `GET /ready` (DB and Redis are available)                              | [Deployment](/en/backend/deployment)         |
| Caching         | Static serving with ETag and `Cache-Control`, process caches                                               | [Caching and ETag](/en/backend/caching-etag) |
| Tests           | Vitest for the backend, a test that watches the architecture layer rules                                   | [Testing](/en/backend/testing)               |
| API Playground  | A separate dev app for manually calling HTTP and WS routes without Postman                                 | [API Playground](/en/playground/)            |
| Deployment      | A build into `dist`, graceful shutdown, working behind a proxy, serving the frontend from the same process | [Deployment](/en/backend/deployment)         |

## Author

The template was developed by **Олександр Блажейко** ([GitHub](https://github.com/Blazheiko), [blazheiko@gmail.com](mailto:blazheiko@gmail.com)). More details on the [About the author](/en/reference/author) page.

## Where to start

1. [Introduction](/en/guide/introduction) — what the template is for and who it suits.
2. [Quick start](/en/guide/getting-started) — installation and first launch.
3. [How the backend works](/en/guide/how-backend-works) — an explanation for beginners.
4. [Project structure](/en/guide/project-structure) — where everything lives.
5. [How to add a feature](/en/backend/adding-a-feature) — a step-by-step tutorial: from a table in the DB to a route.
