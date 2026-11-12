# First route

In 15 minutes you will add a `GET /api/hello` route to the backend that greets the user by name. There is no database, [migrations](/en/reference/glossary#migration) or [authorization](/en/reference/glossary#authentication-and-authorization) here: only the four layers that any request passes through. After this exercise, the full tutorial [How to add a feature](/en/backend/adding-a-feature) will be much easier to read.

::: info Before reading

- The project is running per the [Quick start](/en/guide/getting-started) (`pnpm dev`).
- You have read [How the backend works](/en/guide/how-backend-works): you know what a route, controller and service are.

:::

## What you will get

```bash
curl 'http://127.0.0.1:3000/api/hello?name=Olena'
```

```json
{ "status": "ok", "message": "Hello, Olena!" }
```

| Layer      | File                                                                  | What it does                                                                        |
| ---------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Contract   | `packages/shared/src/schemas/hello/hello-query.ts`                    | Which [query parameters](/en/reference/glossary#query-parameters) the route accepts |
| Contract   | `packages/shared/src/responses/hello-controller.ts`                   | What the response looks like                                                        |
| Service    | `packages/backend/src/app/services/hello/hello-service.ts`            | Business rule: how to greet                                                         |
| Controller | `packages/backend/src/app/controllers/http/hello/hello-controller.ts` | Takes the query, calls the service, builds the response                             |
| Contract   | `packages/shared/src/contracts/hello.ts`                              | The route's method, path and types for the backend and the frontend                 |
| Route      | `packages/backend/src/app/routes/contract-schemas/hello.ts`           | The query and response schemas for the contract                                     |
| Route      | `packages/backend/src/app/routes/http-routes.ts`                      | Ties the contract to the controller                                                 |

All the code below was actually added to a clean copy of the template and checked with `pnpm typecheck`, a test and `curl` requests.

## Step 1. The contract in `shared`

First we describe what the route accepts and what it returns. These descriptions live in the `shared` package so that both the backend and the frontend can import them.

**Input.** The `name` parameter is optional (`?` in the key), from 1 to 50 characters. The schema language is [arktype](https://arktype.io/): the string `'1 <= string <= 50'` reads as "a string of length 1 to 50".

```ts
// packages/shared/src/schemas/hello/hello-query.ts
import { type } from '@arktype/type'

export const HelloQuerySchema = type({
    'name?': '1 <= string <= 50',
})

export type HelloQuery = typeof HelloQuerySchema.infer
```

`HelloQuery` is a plain TypeScript type `{ name?: string }`, inferred from the schema. The schema checks data at runtime, the type at compile time. You write one and get both.

Add a line at the end of `packages/shared/src/schemas/index.ts`:

```ts
export { HelloQuerySchema, type HelloQuery } from './hello/hello-query.js'
```

**Response.** Either success with a message, or the template's standard error (`CanonicalErrorResponseSchema`):

```ts
// packages/shared/src/responses/hello-controller.ts
import { type } from '@arktype/type'
import { CanonicalErrorResponseSchema } from './error-response.js'

export const HelloResponseSchema = type.or(
    { status: "'ok'", message: 'string' },
    CanonicalErrorResponseSchema,
)
export type HelloResponse = typeof HelloResponseSchema.infer
```

And a line at the end of `packages/shared/src/responses/index.ts`:

```ts
export * from './hello-controller.js'
```

The backend dev server (`pnpm dev`) sees changes in `packages/shared/src` at once, but `typecheck`, tests and `start` read the built `dist/`, so rebuild the package before them:

```bash
pnpm --filter shared build
```

## Step 2. Service

The service is the place for business rules. Our rule: without a name we greet the world, we trim whitespace from the name, and a name made only of spaces is an error.

```ts
// packages/backend/src/app/services/hello/hello-service.ts
import { Result } from 'better-result'
import type { AppResult } from '#app/services/shared/errors.js'
import { badRequest } from '#app/services/shared/errors.js'

export const helloService = {
    greet(name?: string): AppResult<{ message: string }> {
        if (name === undefined) {
            return Result.ok({ message: 'Hello, world!' })
        }

        const trimmed = name.trim()
        if (trimmed === '') {
            return Result.err(badRequest('Name must not be blank'))
        }

        return Result.ok({ message: `Hello, ${trimmed}!` })
    },
}
```

Note:

- the service knows nothing about HTTP: no request, no status codes. It can be called from an HTTP controller, from WebSocket or from a test;
- an error is not thrown with `throw` but returned as `Result.err(...)`. The `AppResult` type forces the caller to check the result. The `badRequest` helper from [errors.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/shared/errors.ts) will later be turned into HTTP `400`.

Why won't an empty string get here, while a string of spaces will? The schema from step 1 rejects `name=` (length 0), while `name=%20%20` has length 2 and passes. Checking the shape of the data is done in the schema, checking the meaning in the service.

## Step 3. Controller

The controller translates HTTP into a service call and back. What is in `context` and how to work with it — see [HttpContext in detail](/en/backend/controllers#httpcontext-in-detail).

```ts
// packages/backend/src/app/controllers/http/hello/hello-controller.ts
import type { HttpContext } from '#vendor/types/types.js'
import { Result } from 'better-result'
import { mapControllerError } from '#app/controllers/shared/controller-error.js'
import { helloService } from '#app/services/hello/hello-service.js'
import type { HelloResponse } from 'shared/responses'
import type { HelloQuery } from 'shared/schemas'

export default {
    hello(context: HttpContext<unknown, HelloQuery>): HelloResponse {
        const result = helloService.greet(context.httpData.query.name)
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return { status: 'ok', message: result.value.message }
    },
}
```

- `HttpContext<unknown, HelloQuery>`: the first parameter is the request body type (a GET has none), the second is the query type. Thanks to it, `context.httpData.query.name` has the type `string | undefined`.
- `mapControllerError` sets the HTTP status by the error type (`badRequest` → `400`) and builds a standard response with `code` and `message`.
- The return type `HelloResponse` comes from `shared`: if you return anything else, `pnpm typecheck` will show it.

## Step 4. Route

All that is left is to tell the server that `GET /api/hello` is handled by our controller. Every HTTP route of the template is declared through a **contract** ([Routing](/en/backend/routing#http-routes-defineroute)), so there are three small changes here.

**The contract.** The method, the full path under the `api` prefix and the types of the query and the response. The schemas are imported only as types, so the frontend can import the contract without them:

```ts
// packages/shared/src/contracts/hello.ts
import type { HelloQuerySchema } from '../schemas/hello/hello-query.js'
import type { HelloResponse } from '../responses/hello-controller.js'
import { contract } from './core.js'

export const helloContracts = {
    hello: contract<undefined, typeof HelloQuerySchema.inferIn, HelloResponse>()('get', '/hello'),
} as const
```

Add a line at the end of `packages/shared/src/contracts/index.ts` and run `pnpm --filter shared build` again:

```ts
export { helloContracts } from './hello.js'
```

**The route's schemas.** The backend keeps the schemas of every contract in the `app/routes/contract-schemas/` registry. `contractSchemas` checks the entry against the contract's types: if the keys of `HelloQuerySchema` drift from the contract's query, `pnpm typecheck` shows it.

```ts
// packages/backend/src/app/routes/contract-schemas/hello.ts
import { HelloQuerySchema } from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { helloContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const helloSchemas = contractSchemas(helloContracts, {
    hello: { query: HelloQuerySchema, response: ResponseSchemas.HelloResponseSchema },
})
```

Spread it into `contractSchemaRegistry` in `packages/backend/src/app/routes/contract-schemas/index.ts`:

```ts
import { helloSchemas } from './hello.js'
// ...
export const contractSchemaRegistry = {
    // ...
    ...helloSchemas,
}
```

**The route.** Open [http-routes.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts). `defineRoute` is already imported there from `#app/routes/contract-schemas/index.js`; add the controller import and `helloContracts` to the existing import from `shared/contracts`:

```ts
import HelloController from '#app/controllers/http/hello/hello-controller.js'
// ...
import {
    // ...
    supportContracts,
    helloContracts,
} from 'shared/contracts'
```

Then add the group as the last element of the array, before `] satisfies routeList`:

```ts
    {
        group: [
            defineRoute({
                contract: helloContracts.hello,
                handler: HelloController.hello.bind(HelloController),
                description: 'Say hello',
            }),
        ],
        description: 'Hello routes',
        prefix: 'hello',
    },
```

- The contract path `/hello` + the global `api` prefix = `/api/hello`. The group's `prefix: 'hello'` must be the start of the contract path, otherwise the server does not start.
- The `query` schema of the registry entry — the core will check the query against it **before** calling the controller. Unknown parameters are rejected (a strict policy by default).
- There are no `middlewares`, so the route is public: no session or sign-in is needed. How to close a route to signed-out users is shown in [How to add a feature](/en/backend/adding-a-feature#step-8-contract-and-route-registration).
- The `response` schema describes the response for the API documentation and [API Playground](/en/playground/). During development the server also validates every controller response against it: if it does not match the schema, the client gets `500`, and the log contains the path to the field that did not match. See [Response validation](/en/backend/response-validation). Even before launch, TypeScript checks the type the controller returns against the schema, so we keep the `HelloResponse` annotation in the controller ([Handler response type](/en/backend/routing#handler-response-type)).

`pnpm dev` will restart the backend by itself when you save the file.

## Step 5. Verification

```bash
B=http://127.0.0.1:3000/api
curl -s "$B/hello"
curl -s "$B/hello?name=Olena"
```

```json
{"status":"ok","message":"Hello, world!"}
{"status":"ok","message":"Hello, Olena!"}
```

Now break the request and see who stops it:

| Request                  | Status | Who responded                          | Response body (abridged)                                                     |
| ------------------------ | ------ | -------------------------------------- | ---------------------------------------------------------------------------- |
| `?name=%20%20` (spaces)  | `400`  | the service, the "non-blank name" rule | `{"status":"error","message":"Name must not be blank","code":"bad_request"}` |
| `?name=`                 | `422`  | the schema: length less than 1         | `"code":"validation_failed"`, `"messages":["name must be non-empty"]`        |
| `?nick=Olena`            | `422`  | the schema: unknown parameter          | `"messages":["nick must be removed"]`                                        |
| `?name=` + 51 characters | `422`  | the schema: length greater than 50     | `"messages":["name must be at most length 50 (was 51)"]`                     |

The full `422` response:

```json
{
    "status": "error",
    "code": "validation_failed",
    "message": "Validation failure",
    "details": {
        "kind": "validation",
        "messages": ["name must be non-empty"],
        "issues": [{ "path": "name", "message": "name must be non-empty" }]
    }
}
```

The `422` comes before your controller: the core checks the query earlier (see [How the backend works](/en/guide/how-backend-works#the-path-of-a-single-request)). Your code only receives data that already matches the schema.

## Step 6 (optional). A service test

The service is a plain function with no HTTP and no database, so the test is simple:

```ts
// packages/backend/src/app/services/hello/hello-service.spec.ts
import { Result } from 'better-result'
import { describe, expect, it } from 'vitest'
import { helloService } from './hello-service.js'

describe('helloService.greet', () => {
    it('greets the world when no name is given', () => {
        const result = helloService.greet()

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value.message).toBe('Hello, world!')
        }
    })

    it('greets by trimmed name', () => {
        const result = helloService.greet('  Olena ')

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value.message).toBe('Hello, Olena!')
        }
    })

    it('rejects a blank name with a BadRequest error', () => {
        const result = helloService.greet('   ')

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error._tag).toBe('BadRequest')
        }
    })
})
```

```bash
cd packages/backend && npx vitest run src/app/services/hello
```

Along with this test, run `src/app/layering.spec.ts`: it checks that the layers do not break the import rules (for example, a controller does not call a repository directly).

## What you just used

| Concept                     | Where in this exercise                      | More                                                                     |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| Contract in `shared`        | `HelloQuerySchema`, `HelloResponseSchema`   | [The shared package](/en/shared/), [Validation](/en/backend/validation)  |
| Runtime validation          | the `query` schema in the registry → `422`  | [Validation](/en/backend/validation)                                     |
| `Result` instead of `throw` | `Result.ok` / `Result.err(badRequest(...))` | [Services](/en/backend/services)                                         |
| Error mapping               | `mapControllerError` → `400`                | [Controllers](/en/backend/controllers)                                   |
| Route declaration           | `defineRoute({ contract })` in a group      | [Routing](/en/backend/routing) and [Middleware](/en/backend/middlewares) |

What is still missing here: a database, a session and route protection. The next step adds all of that.

::: tip Next step
[How to add a feature](/en/backend/adding-a-feature): the `notes` resource with a table, a migration, a repository, a transformer and routes for signed-in users only.
:::
