# Routing

Backend routes are described declaratively in two files: HTTP in [`src/app/routes/http-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts), WebSocket in [`src/app/routes/ws-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/ws-routes.ts). At startup the router ([`src/vendor/start/router.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/router.ts)) expands the groups, joins the prefixes and middleware lists, and registers the routes in uWebSockets.js. The general path of a request is described on the [Request lifecycle](/en/backend/request-lifecycle) page, and the chain of checks before the handler on the [Middleware](/en/backend/middlewares) page.

## A route is the single source of truth

Everything the backend knows about an endpoint is written in three places that the compiler checks against each other: the **contract** in `shared/contracts` (method, path, the types of the body, query and response), the **schema registry entry** in the backend (the ArkType schemas of that contract's body, query and response) and the **route object** in `http-routes.ts` (handler, middleware, limits). There is no separate file with access rights and no separate API description: everything is derived from these three places automatically.

| What                           | Where it comes from                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| URL and HTTP method            | the contract's `method` and `path` + `API_PATH_PREFIX`; the group prefix must be the start of `path`                                           |
| Who has access                 | `middlewares` of the route and all its groups                                                                                                  |
| Body and query validation      | the `body` and `query` schemas of the registry entry, the route's `queryAllowExtra`, `queryArrays` — at runtime                                |
| `payload` and `query` types    | TypeScript infers them from the same schemas into the `handler` signature — at compile time                                                    |
| Path parameters (`:id`)        | the router reads them from the contract's `path`                                                                                               |
| Accepted `Content-Type` values | `allowedContentTypes` (JSON only by default; only `multipart` for a multipart contract)                                                        |
| Request rate limit             | `rateLimit` of the route or group                                                                                                              |
| API documentation              | `GET /<prefix>/doc/routes` and the [API Playground](/en/playground/) serialize the same objects: URL, method, middleware, schemas, description |

So the rule is simple: **to change an endpoint's behavior, change its route, its contract or its registry entry.** Add `auth_guard` and the route is closed, which is immediately visible in the playground. Change the body schema in the registry entry and the server-side validation, the `payload` type in the controller and the description in `/doc/routes` all change, and if the schema's input no longer matches the contract's body type, `pnpm typecheck` names the spot. A mismatch between "what the documentation says" and "what the server does" is impossible here, because the documentation is serialized from the same objects.

The schemas themselves live in the `shared` package, so they are the single source of truth for the shape of data between frontend and backend, while the route is the source of truth for how the contract is wired to the server. More in [Where types come from](/en/guide/how-backend-works#where-types-come-from-a-single-source-of-truth).

## HTTP routes: `defineRoute`

Every HTTP route of the application is declared through a **contract** ([ADR 0005](https://github.com/Blazheiko/vibe-template/blob/main/docs/adr/0005-route-contracts.md)). The route table has no other way to declare a route. A contract is a method, a path under the API prefix and three types (body, query, response); at run time it is only `{ method, path }` (and `kind` for non-JSON), so the frontend imports it without schemas and without ArkType.

A new route consists of four parts:

```ts
// 1. packages/shared/src/contracts/push-subscriptions.ts — the contract
export const pushSubscriptionContracts = {
    create: contract<
        typeof CreateSubscriptionInputSchema.inferIn,
        undefined,
        CreateSubscriptionResponse
    >()('post', '/push-subscriptions'),
    // …
} as const

// 2. packages/backend/src/app/routes/contract-schemas/push-subscriptions.ts — the schemas
export const pushSubscriptionSchemas = contractSchemas(pushSubscriptionContracts, {
    create: {
        body: CreateSubscriptionInputSchema,
        response: ResponseSchemas.CreateSubscriptionResponseSchema,
    },
    // …one entry per contract of the group
})

// 3. packages/backend/src/app/routes/http-routes.ts — the route
import { defineRoute } from '#app/routes/contract-schemas/index.js'

defineRoute({
    contract: pushSubscriptionContracts.create,
    handler: PushSubscriptionController.createSubscription.bind(PushSubscriptionController),
    middlewares: ['auth_guard'],
})

// 4. packages/frontend/src/utils/api.ts — the call
callApi(pushSubscriptionContracts.create, { body })
```

- The **contract** is declared in [`packages/shared/src/contracts/`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/core.ts), one file per group: `contract<Body, Query, Response>()(method, path)`. The path is full, from the API prefix (`/push-subscriptions/:subscriptionId`), not relative to the group. Schema types are imported with `import type`, so the contract's JS contains no schema. The group is exported from [`contracts/index.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/index.ts) (the `shared/contracts` subpath).
- The route **schemas** live in one **registry**, [`app/routes/contract-schemas/`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/contract-schemas/index.ts), one file per contract group, and [`index.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/contract-schemas/index.ts) spreads them into `contractSchemaRegistry`, keyed by `<method> <path>` of the contract. [`contractSchemas(group, { name: { body?, query?, response } })`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/contract-registry.ts) requires an entry for every contract of the group and checks it against the contract's types: the input of the `body` schema equals the body type, the keys of the `query` schema equal the keys of the contract's query, the success branches of the `response` schema equal the response type. The body schema of another route, a missing or extra schema, another response schema, a missing contract is a `pnpm typecheck` error with the reason in `__contractMismatch`. The registry is in the backend, so the schemas never reach the frontend bundle.
- **`defineRoute`** is exported by [`app/routes/contract-schemas/index.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/contract-schemas/index.ts) (built by `contractRouteDefiner(contractSchemaRegistry)`). It takes `method` and `url` from the contract and `validator`, `queryValidator` and `ResponseSchema` from the registry entry: it wraps the body schema in `defaultValidator` and applies the extra-keys policy to the query schema. The route does not write these fields. The handler's `payload` and `query` types are the outputs (`infer`) of the entry's schemas. A contract without an entry is a compile error, and at start `Route contract … has no entry in the schema registry`. The result type is `RouteItem` from [`vendor/types/types.d.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/types/types.d.ts).
- Middlewares, limits, `allowedContentTypes`, `maxBodySize` and the route's group stay backend configuration: the contract says nothing about them. The route sits in the group whose prefix is the start of the contract's path; otherwise the server does not start (`Route contract /… is declared in the route group "/…"`).
- On the frontend, [`callApi(contract, { params, query, body }, options)`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/api-client.ts) calls the contract's route on top of the existing transport (CSRF, the session gate; `options` are `signal`, `csrfRecovery`, `sessionAfter`). A wrong body, path parameter or query key is a compile error. Direct `baseApi.http` and `baseApi.upload` calls outside `utils/api-client.ts` are forbidden by an ESLint rule in [`packages/frontend/eslint.config.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/eslint.config.ts).
- `pnpm check:bundle-graph` (part of `make check`) checks on the module graph of the production build that no schema and no ArkType got into the frontend bundle.

### Multipart and navigation routes

- `multipartContract<Fields, 'file-name', Response>()('post', path)` is a body of text fields and files. The registry entry describes the schema of the **fields**; the files are read from `httpData.files`. `defineRoute` sets `allowedContentTypes: ['multipart']` itself, and `maxBodySize` stays a setting of the route. On the frontend, `callApi(avatarContracts.upload, { body: { fields: {}, files: { avatar: blob } } })` builds a `FormData` and sends it through `baseApi.upload` with the same CSRF token and session gate. An example from `http-routes.ts`:

```ts
defineRoute({
    contract: avatarContracts.upload,
    handler: AvatarController.uploadAvatar.bind(AvatarController),
    maxBodySize: multipartBodyLimit(AVATAR_MAX_FILE_BYTES),
    description: 'Upload user avatar',
}),
```

- `navigationContract<Query, Response>()(path)` is a GET the browser does not fetch but opens: the OAuth redirect (`/auth/oauth/:provider/redirect`, `callback`) or a file (`/support/screenshot/:articleId` for an `<img>`). `callApi` does not take such a contract; [`contractUrl(contract, { params, query })`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/api-client.ts) builds its URL.

### A route without a contract: tests only

The helper that builds a route from schemas without a contract is called `defineRawRoute` and lives in [`src/app/routing/define-raw-route.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/define-raw-route.ts). It takes `url`, `method`, `validator`, `queryValidator` and `ResponseSchema` directly and is needed only by the tests of the HTTP machinery (body methods, limits, validation, cache in `src/vendor/start/*.spec.ts`), which build routes of their own.

- The `no-restricted-imports` ESLint rule in the root [`eslint.config.ts`](https://github.com/Blazheiko/vibe-template/blob/main/eslint.config.ts) forbids importing `#app/routing/define-raw-route.js` in `packages/backend/src` outside `*.spec.ts`/`*.test.ts`.
- The test [`route-contracts.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/route-contracts.spec.ts) walks the whole `http-routes.ts` table and fails if a route has no contract, no registry entry, no response schema or, for `post`/`put`/`patch`, no body schema; and also if the registry has an entry without a route.

## All route fields

The fields `defineRoute` takes. The type is `RouteConfig` in [`vendor/types/types.d.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/types/types.d.ts) without the fields the contract and the registry provide.

### Required

| Field      | Type                                       | What it does                                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract` | a contract from `shared/contracts`         | Gives the route its method and path and the key of its entry in the schema registry. The `:name` segments of the path become parameters: the router collects them into `parametersKey`, and the values arrive in `httpData.params` (`/:provider/callback` → `params.provider`). |
| `handler`  | `(context) => Payload \| Promise<Payload>` | A controller method bound via `.bind(Controller)`. The type of `context.httpData.payload` is inferred from the `body` schema of the registry entry, the type of `context.httpData.query` from the `query` schema. The returned value becomes the response body.                 |

### What the contract and the registry provide

These fields exist in `RouteConfig`, but you **do not write them** in `defineRoute`: `defineRoute` fills them in itself, and TypeScript does not accept them in the route.

| Field            | From                             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`            | the contract's `path`            | The full path under the API prefix; the group prefix must be its start. Slashes at the edges are normalized.                                                                                                                                                                                                                                                                                                                                                      |
| `method`         | the contract's `method`          | `'get' \| 'post' \| 'put' \| 'patch' \| 'delete'`. `delete` is converted internally to `del` (the name uWebSockets.js uses). Whether the body is read depends on the method — see [below](#methods-and-request-body).                                                                                                                                                                                                                                             |
| `validator`      | `body` of the registry entry     | The body schema from `shared/schemas`, wrapped in `defaultValidator`. Only for `post`/`put`/`patch`: `get`/`delete` contracts declare the body as `undefined`, and a `get`/`delete` route with a body schema stops startup. Invalid body → `422`.                                                                                                                                                                                                                 |
| `queryValidator` | `query` of the registry entry    | The query string schema with the extra-keys policy (see `queryAllowExtra`). If the contract has no query, `httpData.query === null`, and reading any field is a TypeScript error. Query is validated before the body is read.                                                                                                                                                                                                                                     |
| `ResponseSchema` | `response` of the registry entry | The response schema from `shared/responses`. It ends up in `/doc/routes` (`outputSchema`) and in the playground, and at runtime it works as an allow-list: a mismatch is `500`, extra fields are `500` in `strict` and are stripped in `log` (`RESPONSE_VALIDATION_CONTRACT`, see [Response validation](/en/backend/response-validation)). TypeScript checks the handler's result type against this schema — see [Handler response type](#handler-response-type). |
| `contractPath`   | the contract's `path`            | Internal: the router checks the group prefix against it, and `route-contracts.spec.ts` checks the registry entry.                                                                                                                                                                                                                                                                                                                                                 |

### Request

| Field                 | Type                | Default               | What it does                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queryAllowExtra`     | `boolean`           | `false`               | `false` — strict: an undeclared key → `422` (`onUndeclaredKey('reject')`). `true` — extra keys are let through, but **removed** and never reach the controller. Needed when the query is built by a third-party system (OAuth callback).                                                                                                                            |
| `queryArrays`         | `readonly string[]` | `[]`                  | Keys that may repeat (`?tag=a&tag=b`). They are collected into `string[]` via `getAll`. Any other key that appears twice → `422`.                                                                                                                                                                                                                                   |
| `allowedContentTypes` | `BodyKind[]`        | `['json']`            | Which body types the route accepts: `json`, `multipart`, `urlencoded`, `text`, `octet`, `other`. Any other `Content-Type` → `415`. The body size limit depends on the type too (`MAX_JSON_BODY_SIZE`, `MAX_MULTIPART_BODY_SIZE`, etc., see [Request lifecycle](/en/backend/request-lifecycle)). For a multipart contract `defineRoute` sets `['multipart']` itself. |
| `maxBodySize`         | `number`            | the body type's limit | The route's own body size limit in bytes. The avatar and knowledge base screenshot uploads set it via `multipartBodyLimit(...)` from [`upload-limits.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/shared/upload-limits.ts).                                                                                          |

### Access and limits

| Field         | Type                                        | What it does                                                                                                                                                                                           |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `middlewares` | `string[]`                                  | Names of middleware from `kernel.ts` that run before the handler. Added **after** the group middleware. An unknown name is an error `No middleware <name>`. See [Middleware](/en/backend/middlewares). |
| `rateLimit`   | `{ windowMs: number, maxRequests: number }` | Request limit from one IP for this route per `windowMs` ms window. Exceeding it → `429`. If not set, the `rateLimit` of the nearest group applies. Checked before the body is read.                    |

### Documentation

| Field         | Type     | What it does                                            |
| ------------- | -------- | ------------------------------------------------------- |
| `description` | `string` | Short description for `/doc/routes` and the playground. |

### Internal fields

These fields exist in the `RouteConfig` type, but **you do not set them by hand**:

| Field            | Who fills it in                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `parametersKey`  | the router — the list of `:param` names from the path                                                  |
| `groupRateLimit` | the router — the group limit inherited by the route                                                    |
| `requestBody`    | nobody: a deprecated field of the old request description format, the router and server do not read it |

## Handler response type

[`defineRoute`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/contract-registry.ts) and [`defineWsRoute`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/define-ws-route.ts) require the handler to return the response schema's **input** type (`inferIn`) or a `Promise` of it ([route-response.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/route-response.ts)). For an HTTP route that is the `response` schema of the registry entry, for WS the route's `ResponseSchema`. This is the same value that [response validation](/en/backend/response-validation) feeds into the schema at runtime. A mismatch is a `tsc` error on the route's `handler:` line, on all routes and not only the ones that get called, and also for responses without runtime validation (3xx, 204, 205).

Without a response schema (possible only in a WS route or in `defineRawRoute` in tests) the handler returns any `Payload`.

Limits:

- **Keep the controller's result annotation** (`Promise<XxxResponse>` or `as const`). Without it `return { status: 'success' }` is inferred as `{ status: string }` and fails the check. This also applies to an inline handler directly in `defineRoute`: TypeScript widens the literal when the contextual type is generic.
- The schema must be of the exact `Type`. For `Type | undefined` (for example, from a conditional expression) there is no check.
- TypeScript allows extra fields (structural typing). They are cut off by the runtime validation: `500` in `strict`, stripping in `log` ([Response validation](/en/backend/response-validation)).
- A schema whose input is not a `Payload` (for example, a top-level array) accepts no result at all.
- Redirect schemas (`{ status: 'redirect' }`, OAuth `redirect`/`callback`) are checked only by TypeScript: 3xx responses are not validated at runtime.

This is what the error looks like when the controller's type is wider than the schema (shortened):

```text
src/app/routes/http-routes.ts(290,17): error TS2322: Type '(context: HttpContext<...>) =>
  Promise<{ status: string; message: string; sent?: number; failed?: number; }>' is not
  assignable to type 'TypedHandler<HttpContext<...>, { status: "error"; code: ...; } | { ...; }>'.
  ...
          Types of property 'status' are incompatible.
            Type 'string' is not assignable to type '"success"'.
```

It is best to read from the end: the last lines name the field that did not match. The union with `CanonicalErrorResponseSchema` in the middle of the message is expanded in full.

## Methods and request body

| Method                      | Body is read | Body schema (`body` in the registry, `validator`)                      |
| --------------------------- | ------------ | ---------------------------------------------------------------------- |
| `post`, `put`, `patch`      | yes          | allowed; required for a route of the table (`route-contracts.spec.ts`) |
| `get`, `delete` (`del`)     | no           | forbidden: a startup error (and a type error in `defineRawRoute`)      |
| WS routes (`defineWsRoute`) | —            | allowed (the message payload)                                          |

- Use `patch` for partial updates.
- `DELETE` does not read the body: per [RFC 9110 §9.3.5](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.5) the content of a `DELETE` has no generally defined semantics, and some proxies drop it. Pass the identifier via a `:param` in the contract's path (`'/notes/:id'`), and any extra data via the contract's query and the `query` schema in the registry.
- The startup check is done by `routesHandler` ([router.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/router.ts)): a `get`/`delete` route with `validator`, declared bypassing the types, stops startup with the error `Route DELETE … declares a body validator…`. The method sets are in [body-methods.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/routing/body-methods.ts).
- For how a request without `Content-Type` is handled, see [Request lifecycle](/en/backend/request-lifecycle#request-without-content-type).

## Groups and prefixes

Routes are combined into groups `{ group, prefix, middlewares, rateLimit, description }` (type `groupRouteItem`):

| Field         | Required | What it does                                                                                         |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `group`       | yes      | an array of routes **or nested groups**                                                              |
| `prefix`      | yes      | a path segment the contract paths of all routes in the group must start with                         |
| `middlewares` | no       | middleware for all routes in the group; run before the route's own middleware                        |
| `rateLimit`   | no       | limit for every route in the group if the route has none of its own; also passed on to nested groups |
| `description` | no       | group description                                                                                    |

A list item can be a group: `{ group: [...], prefix, middlewares, rateLimit, description }`. An example from `http-routes.ts`:

```ts
{
  group: [ /* defineRoute({ contract: ..., handler: ... }) */ ],
  description: "Admin user and online routes",
  middlewares: ["session_web", "csrf_guard", "auth_guard", "admin_guard"],
  prefix: "admin",
},
```

Merge rules (see `router.ts`):

- the route's path is the `path` of its contract, already with the group prefix: the router does not add the prefix but checks that `path` starts with it (`/push-subscriptions/:subscriptionId` in the `push-subscriptions` group). The global prefix `appConfig.pathPrefix` from the env variable `API_PATH_PREFIX` (default `api`, [`src/config/app.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/app.ts)) is added to all of it. So the contract `/auth/logout` in the `auth` group becomes `/api/auth/logout`;
- group middleware goes **before** the route's middleware (`middlewares.concat(route.middlewares)`);
- the route's `rateLimit` takes priority over the group's `rateLimit` (`route.rateLimit ?? groupRateLimit`). The counter is kept separately for each route (key IP + URL), so the group limit applies to each of its routes separately, not to the group as a whole. On top of this, all API requests from an IP are restricted by the global L1, see [Request rate limiting](/en/backend/security#rate-limiting).

A group's set of middleware determines who its routes are for: a group with `session_web` and `csrf_guard` serves the SPA, a group without them serves external API clients. A route cannot turn off its group's middleware, so an API route is not placed in a web group. See [Web routes and public API](/en/backend/web-and-api-routes).

In the repository, for example, the `auth` group has a limit of `{ windowMs: 60_000, maxRequests: 10 }`, and individual routes inside have a stricter `maxRequests: 3`. The limit is checked before the request body is read ([`src/vendor/start/server.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/server.ts)).

## WebSocket routes: `defineWsRoute`

WS routes are defined via [`src/app/routing/define-ws-route.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/define-ws-route.ts) and are also grouped with `prefix` and `rateLimit`. The `url` field here is the event name (for example `support_chat`), without an HTTP method. There is a single socket endpoint: `/${pathPrefix}/websocket`. The event dispatcher is [`src/vendor/utils/routing/ws-api-dispatcher.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/routing/ws-api-dispatcher.ts).

```ts
{
  group: [
    defineWsRoute({
      url: "support_chat",
      handler: SupportWsController.chat.bind(SupportWsController),
      validator: SupportChatInputSchema,
      ResponseSchema: ResponseSchemas.SupportChatResponseSchema,
      description: "Send a message to the support agent",
    }),
  ],
  prefix: "support",
  rateLimit: { windowMs: 60_000, maxRequests: 60 },
},
```

## Route introspection and API Playground

[`src/vendor/utils/routing/serialize-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/routing/serialize-routes.ts) serializes the source HTTP and WS routes (URL, method, middleware, description, schemas). The server serves them at `GET /${pathPrefix}/doc/routes` as JSON `{ httpRoutes, wsRoutes, pathPrefix }`, but **only** if all of these hold at once:

- `APP_ENV=manual-test`;
- `DOC_PAGE=true` (`configApp.docPage`, default `false`);
- `SERVE_STATIC=true`.

Otherwise the endpoint returns `404`. Note that [`.env.example`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/.env.example) has `APP_ENV=local`, so for the playground you need to change it manually.

Workflow:

1. In `packages/backend/.env` set `APP_ENV=manual-test`, `DOC_PAGE=true`, `SERVE_STATIC=true`.
2. From the root run `pnpm dev:manual_test` — it builds `shared`, then runs the backend (`tsx watch`) and [`packages/api-playground`](https://github.com/Blazheiko/vibe-template/blob/main/packages/api-playground) (Vite) in parallel.
3. The playground (a Vue app) proxies requests to `http://127.0.0.1:3000` ([`vite.config.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/api-playground/vite.config.ts)), loads `/api/doc/routes` ([`stores/api-doc.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/api-playground/src/stores/api-doc.ts)) and lets you call HTTP and WS routes manually.

::: info OpenAPI
OpenAPI is not used in the project, and we do not plan to generate it. The [`src/openapi`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/openapi) directory contains only unused stubs: `spec.ts` is empty, `schemas.ts` has only a commented-out import. The API description is provided by `/doc/routes` together with the api-playground.
:::
