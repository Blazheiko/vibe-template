# Glossary

Terms that appear in the code and in this documentation. Term names are kept in English, as in the code. The basis is taken from [`docs/reference/template-glossary.md`](https://github.com/Blazheiko/vibe-template/blob/main/docs/reference/template-glossary.md); each definition was checked against the code and supplemented with terms from other pages of the site.

The page has two parts. **Basic concepts** explain general web development terms in plain language, with examples from the template. **Template terms** describe names from this repository's code.

## Basic concepts

### Endpoint

An address on the server where you can do something: get data, create a record. It consists of an HTTP method and a path, for example `GET /api/main/init`. In the template's code an endpoint is declared as a route via `defineRoute({ contract, handler })` with a contract in `shared/contracts` (see [First route](/en/guide/first-endpoint)).

### HTTP method

The verb of a request that tells the server which action to perform. `GET` — read, `POST` — create or perform an action, `PUT`/`PATCH` — change, `DELETE` — delete. In the template the method determines whether the request body is read (only `POST`, `PUT`, `PATCH`) and whether a CSRF token is required (`POST`, `PUT`, `PATCH`, `DELETE`).

### Status code

A three-digit number in the response that briefly says how the request ended. `200` — success, `401` — you are not signed in, `403` — forbidden, `404` — not found, `422` — the data did not pass validation, `500` — a server error. Error responses in the template also have a `code` field, for example `"code":"validation_failed"`.

### JSON

The text data format the template's API works with: `{"status":"ok","message":"Hello, world!"}`. Both requests with a body and responses are sent as JSON.

### Header

Additional information for a request or response in the form `name: value`. For example, `content-type: application/json` says the body is JSON, and `x-csrf-token` carries the CSRF token. The template's response headers also enable browser protections (`content-security-policy`, `x-frame-options`).

### Cookie

A small record that the server asks the browser to store (the `Set-Cookie` header) and that the browser then adds to every request to that site on its own. In the template the `uapi` cookie contains a signed session identifier. It has the `HttpOnly` flag, so JavaScript on the page cannot see it.

### CSRF

Cross-Site Request Forgery: a third-party site makes the browser send a data-changing request to your site, and the browser adds the session cookie to it on its own. The template defends against this with a `SameSite` cookie, `Sec-Fetch-Site` and `Origin` checks, and a CSRF token in the `x-csrf-token` header. In plain words — [CSRF in plain words](/en/guide/csrf).

### Payload / request body

The data the client sends along with the request, usually as JSON: `{"title":"Buy milk"}`. `GET` has no body; parameters are passed in the query.

### Query parameters

The part of the address after `?`: in `/api/hello?name=Olena` the `name` parameter equals `Olena`. A route describes the allowed parameters via `queryValidator`.

### Session

A way to "remember" the user between requests. After sign-in the server creates a record in Redis and gives the browser a cookie with its identifier. The server recognizes every following request with this cookie as yours. Signing out deletes the record, and the cookie no longer opens anything.

### Authentication and authorization

**Authentication** answers the question "who are you?": sign-in by password, SMS code, or via Google. **Authorization** — "what are you allowed to do?": for example, the admin panel is available only to the `admin` role. In the template the first is checked by the `auth_guard` middleware (there is a session with a user), the second by `admin_guard` (the admin role).

### Middleware

A function that runs before your handler and can stop the request. Like a guard at the entrance: it checks the session or CSRF token and either lets the request through or responds with an error. In the template's routes middleware are listed by name: `['session_web', 'csrf_guard', 'auth_guard']`.

### Runtime validation

Checking data while the program is running. TypeScript checks types only at compile time, while data from the client arrives later and can be anything. So incoming data is checked by an arktype schema on every request. An invalid request gets `422` and does not reach your code (see [Validation](/en/backend/validation)).

### Single source of truth

The principle: every fact about the system is described in one place, and everything else is derived from it. In the template the API contract is an arktype schema in `shared`, and the DB structure is a Drizzle schema in `schema.ts`. If you change the description, both the validation and the type change, so copies do not drift apart (see [Where types come from](/en/guide/how-backend-works#where-types-come-from-a-single-source-of-truth)).

### Type inference

When a TypeScript type is not written by hand but obtained from another description. `typeof LoginInputSchema.infer` gives the type from an arktype schema, `InferSelectModel<typeof users>` — the row type of a Drizzle table.

### ORM

A library that lets you work with a database through programming-language code instead of hand-written SQL. The template uses Drizzle ORM: tables are described in TypeScript, and queries like `db.select().from(notes)` are typed.

### Migration

A file with changes to the database structure (create a table, add a column) that is applied once and in order. In the template, migrations are generated by `pnpm --filter backend db:generate` from changes in `schema.ts` and applied by `db:migrate`. This way the database on every machine has the same structure.

### WebSocket

A persistent connection between the browser and the server over which both sides can send messages at any time. Unlike HTTP ("asked — got a response"), the server itself notifies the client about events: a new user is online, part of an AI response. See [WebSocket](/en/backend/websocket).

## Template terms

| Term                        | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Learn more                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| API playground              | A Vue app for developers and QA ([`packages/api-playground`](https://github.com/Blazheiko/vibe-template/blob/main/packages/api-playground)). It loads the route description from `GET /api/doc/routes` and lets you call HTTP and WS routes manually. Works only in manual-test mode                                                                                                                                                                                                            | [API Playground](/en/playground/), [Routing](/en/backend/routing)     |
| AppResult                   | `AppResult<T> = ResultType<T, AppError>` from [`services/shared/errors.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/shared/errors.ts). This is a service result that carries either a value or a typed error instead of an exception. The controller maps it to an HTTP status                                                                                                                                                                   | [Services](/en/backend/services)                                      |
| Branded type                | A primitive type with a phantom mark that distinguishes semantically different values. Example: `EntityId`, the id of a database row as a string; `EntityIdSchema = type(ENTITY_ID_PATTERN).brand('EntityId')` in [`ids.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/brands/ids.ts), so a plain string has to pass the schema before it becomes an `EntityId`                                                                                                  | [Shared](/en/shared/)                                                 |
| CSRF                        | Cross-site request forgery. The protection is attached by the `csrf_guard` middleware for unsafe methods (`post`, `put`, `patch`, `delete`) when a session is present. By default `CSRF_ENFORCE=false`, meaning violations are only logged                                                                                                                                                                                                                                                      | [Authentication and security](/en/backend/security#csrf)              |
| Synchronizer-token CSRF     | A CSRF model in which the server stores `csrfToken` (32 bytes, base64url) in the session, and the client sends it in the `x-csrf-token` header. The comparison is done via `timingSafeEqual` ([`csrf-guard.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/middlewares/csrf-guard.ts))                                                                                                                                                                       | [Authentication and security](/en/backend/security#csrf)              |
| defineRoute / defineWsRoute | Helpers for declaring HTTP and WS routes: `defineRoute` takes a contract (method, path) and the schemas from the contract registry, `defineWsRoute` takes the request/response schemas directly; both with a `handler` and a description ([`http-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts))                                                                                                                              | [Routing](/en/backend/routing)                                        |
| Embedding                   | A vector representation of text for knowledge base search. The `embedding` column has type `vector(1536)` in [`schema.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/schema.ts)                                                                                                                                                                                                                                                                        | [AI](/en/backend/ai), [Database](/en/backend/database)                |
| ETag                        | A cache validator for static files served by the server. A `304` response is returned when `If-None-Match` matches                                                                                                                                                                                                                                                                                                                                                                              | [Caching and ETag](/en/backend/caching-etag#etag)                     |
| Knowledge base              | Support articles managed by the admin (the `/admin/knowledge-base*` routes). They are used in support AI for embedding search                                                                                                                                                                                                                                                                                                                                                                   | [AI](/en/backend/ai#support-ai-and-the-knowledge-base)                |
| Manual-test mode            | The `APP_ENV=manual-test` mode. Together with `DOC_PAGE=true` and `SERVE_STATIC=true` it enables the `/doc/routes` endpoint for the API playground ([`server.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/server.ts)). Started via `pnpm dev:manual_test`                                                                                                                                                                                        | [Routing](/en/backend/routing#route-introspection-and-api-playground) |
| Middleware                  | A `(context, next)` function in a route's chain: `session_web`, `csrf_guard`, `auth_guard`, `admin_guard`, etc.                                                                                                                                                                                                                                                                                                                                                                                 | [Routing](/en/backend/middlewares)                                    |
| pgvector                    | The PostgreSQL `vector` extension required for the embedding column. `db:create` runs `CREATE EXTENSION IF NOT EXISTS vector`                                                                                                                                                                                                                                                                                                                                                                   | [Database](/en/backend/database)                                      |
| Presence                    | Tracking of authenticated users connected via WebSocket. [`ws-presence-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/communication/ws-presence-service.ts) updates the online state on connect/disconnect and broadcasts `admin_user_online_upsert` / `admin_user_online_remove` events to the admin channel                                                                                                                              | [WebSocket](/en/backend/websocket)                                    |
| Production-like mode        | `appConfig.isProductionLike`: `APP_IS_PRODUCTION`, and if it is not set, `APP_ENV`/`NODE_ENV` with the value `production`/`prod`. Enables the `__Host-` cookie and forbids fake SMS                                                                                                                                                                                                                                                                                                             | [Configuration](/en/backend/configuration#production-like-mode)       |
| Prompts (retained prompt)   | Saved AI system prompts that the admin edits and tests (the `/prompts` routes). The backend has no "retained prompt" term (the phrase "retained support prompts" appears only in the text of [`AiPolicy.vue`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/views/AiPolicy.vue)): in code it is the `llm_system_prompts` table (`llmSystemPrompts` in [`schema.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/schema.ts)) | [AI](/en/backend/ai#prompts)                                          |
| Repository                  | The DB access layer via Drizzle, for example [`user-repository.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/repositories/user/user-repository.ts). Services work with tables through repositories                                                                                                                                                                                                                                                         | [Repositories](/en/backend/repositories)                              |
| Session                     | The state of an authenticated browser in Redis. The client keeps its identifier in an HTTP-only cookie ([`config/session.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/session.ts)). The `session_web` middleware                                                                                                                                                                                                                                       | [Authentication and security](/en/backend/auth#sessions)              |
| Support chat                | A user's chat with the AI support agent over WebSocket (the WS routes `support_open_chat`, `support_chat`) and the HTTP history `/support/chat/history`                                                                                                                                                                                                                                                                                                                                         | [AI](/en/backend/ai), [WebSocket](/en/backend/websocket)              |
| Transformer                 | A function that serializes a DB row into its public form. For example, [`user-transformer.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/transformers/user-transformer.ts) removes `password` and `sessionToken` and turns `id` and dates into strings                                                                                                                                                                                                      | [Transformers](/en/backend/transformers)                              |
| VAPID                       | A key pair that identifies the server for Web Push. The public key is served at `GET /push-subscriptions/vapid-public-key`                                                                                                                                                                                                                                                                                                                                                                      | [Web Push](/en/backend/web-push-notification#what-vapid-keys-are)     |
| WebSocket token             | The token returned by `/main/init` and `/main/update-ws-token` (both under `auth_guard`). It is stored in Redis for 60 s ([`generate-ws-token-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/generate-ws-token-service.ts)), and the frontend passes it on WS upgrade                                                                                                                                                                 | [WebSocket](/en/backend/websocket#getting-a-token-over-http)          |
