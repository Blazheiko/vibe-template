# Routing

Backend routes are described declaratively in two files: HTTP in [`src/app/routes/http-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts), WebSocket in [`src/app/routes/ws-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/ws-routes.ts). At startup the router ([`src/vendor/start/router.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/router.ts)) expands the groups, joins the prefixes and middleware lists, and registers the routes in uWebSockets.js. The general path of a request is described on the [Request lifecycle](/en/backend/request-lifecycle) page, and the chain of checks before the handler on the [Middleware](/en/backend/middlewares) page.

## A route is the single source of truth

Everything the backend knows about an endpoint is written **in one route object**. There is no separate file with access rights, no separate API description and no separate schema registration: everything is derived from this object automatically.

| What                           | Where it comes from                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| URL and HTTP method            | `url`, `method` + group `prefix` values + `API_PATH_PREFIX`                                                                                    |
| Who has access                 | `middlewares` of the route and all its groups                                                                                                  |
| Body and query validation      | `validator`, `queryValidator`, `queryAllowExtra`, `queryArrays` — at runtime                                                                   |
| `payload` and `query` types    | TypeScript infers them from the same schemas into the `handler` signature — at compile time                                                    |
| Path parameters (`:id`)        | the router reads them from `url`                                                                                                               |
| Accepted `Content-Type` values | `allowedContentTypes` (JSON only by default)                                                                                                   |
| Request rate limit             | `rateLimit` of the route or group                                                                                                              |
| API documentation              | `GET /<prefix>/doc/routes` and the [API Playground](/en/playground/) serialize the same objects: URL, method, middleware, schemas, description |

So the rule is simple: **to change an endpoint's behavior, change its route.** Add `auth_guard` and the route is closed, which is immediately visible in the playground. Change a schema in `validator` and the server-side validation, the `payload` type in the controller and the description in `/doc/routes` all change. A mismatch between "what the documentation says" and "what the server does" is impossible here, because it is one and the same object.

The schemas themselves live in the `shared` package, so they are the single source of truth for the contract between frontend and backend, while the route is the source of truth for how that contract is wired to the server. More in [Where types come from](/en/guide/how-backend-works#where-types-come-from-a-single-source-of-truth).

## HTTP routes: `defineRoute`

The `defineRoute` helper lives in [`src/app/routing/define-route.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/define-route.ts). It wraps ArkType schemas in `defaultValidator`, applies the extra-keys policy for query, and infers the `payload`/`query` types for the handler. The object type is `RouteConfig` in [`vendor/types/types.d.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/types/types.d.ts).

```ts
defineRoute({
    url: '/upload',
    method: 'post',
    handler: AvatarController.uploadAvatar.bind(AvatarController),
    validator: EmptyFormInputSchema,
    allowedContentTypes: ['multipart'],
    ResponseSchema: ResponseSchemas.UploadAvatarResponseSchema,
    description: 'Upload user avatar',
}),
```

This is the real avatar upload route from the `avatar` group in [`http-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts): it accepts `multipart/form-data` instead of JSON.

## All route fields

### Required

| Field     | Type                                              | What it does                                                                                                                                                                                                                                            |
| --------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`     | `string`                                          | Path relative to the group prefix. `:name` segments become path parameters: the router collects them into `parametersKey`, and the values arrive in `httpData.params` (`/:provider/callback` → `params.provider`). Slashes at the edges are normalized. |
| `method`  | `'get' \| 'post' \| 'put' \| 'patch' \| 'delete'` | HTTP method. `delete` is converted internally to `del` (the name uWebSockets.js uses). Whether the body is read depends on the method — see [below](#methods-and-request-body).                                                                         |
| `handler` | `(context) => Payload \| Promise<Payload>`        | A controller method bound via `.bind(Controller)`. The type of `context.httpData.payload` is inferred from `validator`, the type of `context.httpData.query` from `queryValidator`. The returned value becomes the response body.                       |

### Request validation

| Field                 | Type                | Default    | What it does                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validator`           | ArkType schema      | —          | Request body schema from `shared/schemas`. Allowed only for `post`/`put`/`patch`: on `get`/`delete` it is a type error in `defineRoute` and a startup error. Invalid body → `422`. Without `validator` the body is not validated and `payload` has type `unknown`.                                                                  |
| `queryValidator`      | ArkType schema      | —          | Query string schema. If not set, `httpData.query === null`, and reading any field is a TypeScript error. Query is validated before the body is read.                                                                                                                                                                                |
| `queryAllowExtra`     | `boolean`           | `false`    | `false` — strict: an undeclared key → `422` (`onUndeclaredKey('reject')`). `true` — extra keys are let through, but **removed** and never reach the controller. Needed when the query is built by a third-party system (OAuth callback).                                                                                            |
| `queryArrays`         | `readonly string[]` | `[]`       | Keys that may repeat (`?tag=a&tag=b`). They are collected into `string[]` via `getAll`. Any other key that appears twice → `422`.                                                                                                                                                                                                   |
| `allowedContentTypes` | `BodyKind[]`        | `['json']` | Which body types the route accepts: `json`, `multipart`, `urlencoded`, `text`, `octet`, `other`. Any other `Content-Type` → `415`. The body size limit depends on the type too (`MAX_JSON_BODY_SIZE`, `MAX_MULTIPART_BODY_SIZE`, etc., see [Request lifecycle](/en/backend/request-lifecycle)). Avatar upload uses `['multipart']`. |

### Access and limits

| Field         | Type                                        | What it does                                                                                                                                                                                           |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `middlewares` | `string[]`                                  | Names of middleware from `kernel.ts` that run before the handler. Added **after** the group middleware. An unknown name is an error `No middleware <name>`. See [Middleware](/en/backend/middlewares). |
| `rateLimit`   | `{ windowMs: number, maxRequests: number }` | Request limit from one IP for this route per `windowMs` ms window. Exceeding it → `429`. If not set, the `rateLimit` of the nearest group applies. Checked before the body is read.                    |

### Documentation

| Field            | Type           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ResponseSchema` | ArkType schema | Response schema from `shared/responses`. It ends up in `/doc/routes` (`outputSchema`) and in the playground, and at runtime it works as an allow-list: a mismatch is `500`, extra fields are `500` in `strict` and are stripped in `log` (`RESPONSE_VALIDATION_CONTRACT`, see [Response validation](/en/backend/response-validation)). TypeScript checks the handler's result type against this schema — see [Handler response type](#handler-response-type). |
| `description`    | `string`       | Short description for `/doc/routes` and the playground.                                                                                                                                                                                                                                                                                                                                                                                                       |

### Internal fields

These fields exist in the `RouteConfig` type, but **you do not set them by hand**:

| Field            | Who fills it in                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `parametersKey`  | the router — the list of `:param` names from `url`                                                     |
| `groupRateLimit` | the router — the group limit inherited by the route                                                    |
| `requestBody`    | nobody: a deprecated field of the old request description format, the router and server do not read it |

## Handler response type

If a route declares `ResponseSchema`, [`defineRoute`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/define-route.ts) and [`defineWsRoute`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/define-ws-route.ts) require the handler to return the schema's **input** type (`inferIn`) or a `Promise` of it ([route-response.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/route-response.ts)). This is the same value that [response validation](/en/backend/response-validation) feeds into the schema at runtime. A mismatch is a `tsc` error on the route's `handler:` line, on all routes and not only the ones that get called, and also for responses without runtime validation (3xx, 204, 205).

Without `ResponseSchema` the handler returns any `Payload`, as before.

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

## Routes with a contract: `defineContractRoute`

Some routes are declared through a **contract** from `shared/contracts` ([ADR 0005](https://github.com/Blazheiko/vibe-template/blob/main/docs/adr/0005-route-contracts.md)): the `push-subscriptions` group, `POST /auth/login`, `GET /admin/users` and the admin monitoring routes (`/admin/users-online`, `/admin/users-online/:id`, `/admin/history-online`, `/admin/usage/text`, `/admin/usage/stats`). A contract is a method, a path under the API prefix and three types (body, query, response); at run time it is only `{ method, path }`, so the frontend imports it without schemas and without ArkType.

```ts
// packages/shared/src/contracts/push-subscriptions.ts
export const pushSubscriptionContracts = {
    create: contract<
        typeof CreateSubscriptionInputSchema.inferIn,
        undefined,
        CreateSubscriptionResponse
    >()('post', '/push-subscriptions'),
}

// packages/backend/src/app/routes/contract-schemas/push-subscriptions.ts
export const pushSubscriptionSchemas = contractSchemas(pushSubscriptionContracts, {
    create: {
        body: CreateSubscriptionInputSchema,
        response: ResponseSchemas.CreateSubscriptionResponseSchema,
    },
    // …one entry per contract of the group
})

// packages/backend/src/app/routes/http-routes.ts
defineContractRoute({
    contract: pushSubscriptionContracts.create,
    handler: PushSubscriptionController.createSubscription.bind(PushSubscriptionController),
    middlewares: ['auth_guard'],
})

// packages/frontend/src/utils/api.ts
callApi(pushSubscriptionContracts.create, { body })
```

- The schemas of the routes with a contract live in one **registry**, [`app/routes/contract-schemas/`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/contract-schemas/index.ts), a file per contract group, keyed by `<method> <path>` of the contract. [`contractSchemas`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/contract-registry.ts) requires an entry for every contract of the group and checks it against the contract's types: the body schema of another route, a missing or extra schema, another response schema, a missing contract is a `pnpm typecheck` error. The registry is in the backend, so the schemas never reach the frontend bundle.
- `defineContractRoute` takes `method` and `url` from the contract and `validator`, `queryValidator` and `ResponseSchema` from the registry entry; the route table does not name them. The handler's `payload` and `query` types are the outputs of the entry's schemas. A contract without an entry is a compile error, and at start `Route contract … has no entry in the schema registry`.
- Middlewares, limits, `allowedContentTypes`, `maxBodySize` and the route's group stay backend configuration. The route sits in the group whose prefix is the start of the contract's path; otherwise the server does not start.
- On the frontend, [`callApi`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/api-client.ts) calls the contract's route on top of the existing transport (CSRF, the session gate). A wrong body, path parameter or query key is a compile error. Direct `baseApi.http` calls outside `utils/api.ts` are forbidden by an ESLint rule; inside `utils/api.ts` their number is held by the test [`api-direct-calls.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/__tests__/api-direct-calls.spec.ts).
- `pnpm check:bundle-graph` (part of `make check`) checks on the module graph of the production build that no schema and no ArkType got into the frontend bundle.

The other routes are declared with `defineRoute` and move to contracts group by group. Multipart routes (file uploads) have no contracts.

## Methods and request body

| Method                      | Body is read | `validator`                                                  |
| --------------------------- | ------------ | ------------------------------------------------------------ |
| `post`, `put`, `patch`      | yes          | allowed                                                      |
| `get`, `delete` (`del`)     | no           | forbidden: a type error in `defineRoute` and a startup error |
| WS routes (`defineWsRoute`) | —            | allowed (the message payload)                                |

- Use `patch` for partial updates.
- `DELETE` does not read the body: per [RFC 9110 §9.3.5](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.5) the content of a `DELETE` has no generally defined semantics, and some proxies drop it. Pass the identifier via `:param` (`url: "/:id"`), and any extra data via `queryValidator`.
- The startup check is done by `routesHandler` ([router.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/router.ts)): a `get`/`delete` route with `validator`, declared bypassing `defineRoute`, stops startup with the error `Route DELETE … declares a body validator…`. The method sets are in [body-methods.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/routing/body-methods.ts).
- For how a request without `Content-Type` is handled, see [Request lifecycle](/en/backend/request-lifecycle#request-without-content-type).

## Groups and prefixes

Routes are combined into groups `{ group, prefix, middlewares, rateLimit, description }` (type `groupRouteItem`):

| Field         | Required | What it does                                                                                         |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `group`       | yes      | an array of routes **or nested groups**                                                              |
| `prefix`      | yes      | a path segment added to the `url` of all routes in the group                                         |
| `middlewares` | no       | middleware for all routes in the group; run before the route's own middleware                        |
| `rateLimit`   | no       | limit for every route in the group if the route has none of its own; also passed on to nested groups |
| `description` | no       | group description                                                                                    |

A list item can be a group: `{ group: [...], prefix, middlewares, rateLimit, description }`. An example from `http-routes.ts`:

```ts
{
  group: [ /* defineRoute(...) */ ],
  description: "Admin user and online routes",
  middlewares: ["session_web", "csrf_guard", "auth_guard", "admin_guard"],
  prefix: "admin",
},
```

Merge rules (see `router.ts`):

- the group prefix is added to the route's `url`, and the global prefix `appConfig.pathPrefix` from the env variable `API_PATH_PREFIX` (default `api`, [`src/config/app.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/app.ts)) is added to all of it. So `/logout` in the `auth` group becomes `/api/auth/logout`;
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
