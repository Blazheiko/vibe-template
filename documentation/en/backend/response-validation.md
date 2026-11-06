# Response validation

A route can declare a `ResponseSchema`: an ArkType schema of what the controller returns. Besides route documentation (`GET /<prefix>/doc/routes`), the server checks every response against it at runtime, and the schema works as a **field allow-list**: the client receives only the fields described in it. The reaction to a violation is set by the `RESPONSE_VALIDATION_CONTRACT` variable.

This is a runtime check. Even before the code runs, TypeScript compares the type of the controller result with the schema, on all routes and also for responses without a body, which are not checked here (3xx, 204, 205); see [Handler response type](/en/backend/routing#handler-response-type). TypeScript allows extra fields; this check strips them.

## Modes

There are two kinds of contract violation: the response **does not match the schema** (wrong type, missing field) or has **fields that are not in the schema**. A mismatch is always `500`: such a response cannot be stripped, and sending it as is would also hand the client any extra fields it contains.

| `RESPONSE_VALIDATION_CONTRACT` | Schema mismatch           | Extra fields                                          | Default            |
| ------------------------------ | ------------------------- | ----------------------------------------------------- | ------------------ |
| `strict`                       | `500`, `error` in the log | `500`, `error` in the log                             | outside production |
| `log`                          | `500`, `error` in the log | stripped, the client gets the rest, `warn` in the log | production         |

Production means `APP_IS_PRODUCTION=true` (or `APP_ENV=production`/`prod`). An unknown value stops the server from starting.

- **There is no `off` mode.** The schema runs on every response in any mode: ArkType strips keys in the same traversal that does the checking, so a "no validation" mode would save nothing.
- **There is no sampling.** An allow-list that applies to only some requests does not protect anything.
- In `strict`, an extra field gives `500` rather than silent stripping: in development, a transformer bug must be noticed and fixed. Stripping is a safety net for production.

```dotenv
RESPONSE_VALIDATION_CONTRACT=log
```

For how to roll the modes out during deployment, see [Deployment](#deployment).

## Deployment

The template does not have a production yet; this is the procedure for a project that deploys it. In `log`, a schema mismatch also gives `500`, and there is no "turn it off" switch, so discrepancies must be found before production.

| Stage                      | Mode               | Condition to move on                                                                                      |
| -------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| Development, CI, e2e       | `strict` (default) | Tests and e2e are green                                                                                   |
| Staging                    | `log`              | At least 7 days without `Response does not match ResponseSchema` entries; every `undeclared_key` reviewed |
| Production, first releases | `log` (default)    | -                                                                                                         |
| Production, optional       | `strict`           | At least 14 days without `undeclared_key` in the logs and Sentry; team decision                           |

- **What to review.** Entries with the Sentry tag `response_validation`: `kind: mismatch` is always `500`, fix the schema or the controller; `kind: undeclared` is a field that is not in the schema. Either it is a leak (remove it in the transformer), or the client needs it (add it to the schema).
- **What `strict` changes in production.** Just one thing: extra fields give `500` instead of being stripped. A schema mismatch is `500` in both modes anyway. `strict` makes sense when the team wants a transformer bug not to go unnoticed even in production.
- **Rollback.** `strict` → `log` via the `RESPONSE_VALIDATION_CONTRACT` variable. A schema mismatch cannot be disabled by the variable: rollback means the previous backend version.

## How a response is checked

[validate-response.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/validation/validate-response.ts) builds, at startup, a schema with `onDeepUndeclaredKey('reject')` for the route and, in `log`, with `onDeepUndeclaredKey('delete')`. For each response:

1. `reject` passes and the response traversal found nothing → **the same object** is sent, without a copy. This is the path of almost all responses.
2. The errors include more than just extra keys → `500`.
3. The response contains a value that `JSON.stringify` may serialize differently from how the schema saw it → `500`. Only a plain object, a plain array and a `Date` without its own `toJSON` (enumerable or not) are allowed. A class instance, a subclass of `Date` or of an array, a `Map`, or a custom `toJSON` on any of them are rejected.
4. The errors are only extra keys: in `strict` → `500`; in `log` → a copy without them is sent. If stripping returned an error, it is also `500`: the original object goes to the client only after a successful `reject`.

Keys named like `Object.prototype` properties (`constructor`, `__proto__`, `hasOwnProperty`, `toString`, etc.) were read by ArkType before `2.2.9` through the prototype and were not considered extra. So a separate traversal looks for them among own keys at any depth and treats them as extra: `500` in `strict`, stripping in `log`. Since `2.2.9`, ArkType itself also reports such keys; in the log each path still appears once, and stripping remains the traversal's job.

Extra keys are searched for at any depth: in nested objects, in array elements and in every branch of a union (success and error).

What is checked is the **object returned by the controller, before JSON serialization**, and the schema describes **exactly the JSON the client receives**. That is why response schemas have no `Date` or `bigint`: the transformer returns the id as a string (`String(id)`) and the date as a UTC ISO string (`toISOString()`), and the schema declares `'string'`. A `Date` or `bigint` that ends up in a response is a mismatch, `500`. ArkType accepts `Infinity` / `-Infinity` as `number`, but JSON would write `null`, so the response traversal also gives `500` (code `non_finite_number`).

Response schemas also have no morphs (`.pipe`, `.parse`): the original object is sent, not the schema's result, so a morph would change the format only for responses with extra keys. This is a permanent rule, not a temporary one. The tests in [route-access.spec.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/route-access.spec.ts) do not let you add a morph, a `Date` or a `bigint` to a route schema.

### Fields without an allow-list guarantee

The content of a field that the schema describes as `unknown` is not filtered at any depth. The TypeScript type does not change this: it does not check values at runtime. Such fields are allowed only as exceptions, and the same test fails on every new one:

| Field                                                                    | Why `unknown`                                                        |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `details` of the canonical error                                         | Built only from `AppError` constructors                              |
| `messageData` of push logs (`GET /push-subscriptions/:id`, `…/:id/logs`) | The `data` of a notification this user's device has already received |

A route that can return an error must accept the full canonical error (`reason`, `details`, `csrfToken`): a schema with a hand-described error would turn a `mapControllerError` response into `500`. The test checks this as well.

### HTTP

The check is performed by `checkHandlerResponse` in [server.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/server.ts) right after the controller, and it sends what the check returned.

| Case                                                                                         | Checked |
| -------------------------------------------------------------------------------------------- | ------- |
| The controller ran and the response has a body, with any status, e.g. `GET /ready` → `503`   | Yes     |
| Middleware stopped the request (`401`, `403`, `429`, CSRF), request validation error         | No      |
| The controller threw an exception (the error handler builds the response)                    | No      |
| Response without a body: `3xx` (including OAuth redirects, `304`), `204`, `205`, empty `2xx` | No      |

The "has a body or not" rule is a single function `hasResponseBody()` in [response-body.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/network/response-body.ts), which `sendResponse` also uses.

When the check replaces the response with `500`, all headers set by the controller (`ETag`, `Content-Disposition`, etc.) are discarded: they described the rejected response. Cookies stay, because the session state on the server has already been changed.

```json
{ "status": "error", "code": "internal_error", "message": "Internal Server Error" }
```

### WebSocket

[ws-api-dispatcher.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/routing/ws-api-dispatcher.ts) checks the handler's direct response the same way: in `log`, extra keys are stripped from `data`, and a rejected response becomes:

```json
{
    "status": "error",
    "data": null,
    "error": { "code": "internal_error", "message": "Internal server error" }
}
```

### Broadcast

Push events (`broadcast:*`) are checked by [broadcast-service.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/communication/broadcast-service.ts) with a schema from the `BroadcastEventSchemas` registry, in the same modes: one check per event, before serialization; the log and Sentry get `transport: "broadcast"`, and `route` is the event name. An invalid event is not sent (there is nobody to answer 500 to); see the table in [WebSocket](/en/backend/websocket#event-contract). Messages that the WS handler sends itself, outside `broadcastService`, are not checked: all asynchronous messages (support agent replies) go through it.

## Logs and Sentry

A mismatch writes an `error` `Response does not match ResponseSchema`, extra keys write `Response has keys undeclared in ResponseSchema` (`error` in `strict`, `warn` in `log`):

```json
{
    "route": "api/auth/login",
    "transport": "http",
    "requestId": "…",
    "mode": "log",
    "kind": "undeclared",
    "rejected": false,
    "issues": [{ "path": "user.avatar", "code": "undeclared_key", "expected": "removed" }],
    "truncated": 0,
    "suppressed": 0
}
```

- Only the path, code and expected type, with no values from the response, so personal data does not end up in the logs. An extra key has the code `undeclared_key`.
- No more than 20 paths per entry, the rest are counted in `truncated`.
- One entry and one Sentry event per route and kind (`kind`: `mismatch` or `undeclared`) per minute: stripping does not hide a `500` on the same route. Skipped ones are counted in `suppressed` of the next entry.
- The Sentry event has the tags `response_validation` (mode), `transport` and `kind`; the level is `error` for `500` and `warning` for stripping. The log itself is marked `sentrySkip`, so the event is not duplicated.

## How it is wired in

`routesHandler` in [router.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/router.ts) creates, once at startup, a `responseCheck` for each route: a check function, or `null` for a route without a `ResponseSchema`. A test builds the check in both modes for every route and every broadcast event: a union with overlapping branches is not accepted by ArkType with `delete`, and the server would not start.

## Cost

**Methodology.** The script [bench-response-check.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/scripts/bench-response-check.ts) (`LOG_LEVEL=silent pnpm --filter backend bench:response`): the schema is a union of a success with a list and the canonical error, an element with 8 fields (including a `Date` and an array), the median of 7 runs after warm-up, Node 24, Apple M1 Pro. Time per call in ms. The HTTP stack, the database and the network are not included in the measurements.

| Elements | `JSON.stringify` | Check before feat-046 | Normal response | With an extra key in every element (`log`) |
| -------- | ---------------- | --------------------- | --------------- | ------------------------------------------ |
| 10       | 0.019            | 0.014                 | 0.020 (1.09×)   | 0.19 (9.9×)                                |
| 100      | 0.179            | 0.143                 | 0.197 (1.10×)   | 1.80 (10.0×)                               |
| 1000     | 1.86             | 1.38                  | 1.98 (1.07×)    | 18.0 (9.7×)                                |

Broadcast event (`support_chat_token`, `admin_user_online_upsert`, the same script, `log` mode): the check takes 0.5–0.7 µs per event against serialization at 0.55–1.0 µs; it is one per event, so it does not depend on the number of recipients.

The whole `createResponseCheck` was measured: `reject`, the response traversal, stripping and writing to the log (`LOG_LEVEL=silent`).

- A normal response costs about one more serialization and is ~40–50% more expensive than the check before feat-046: a response traversal was added to the schema check. There is no copy of the response.
- A response with extra keys is about ten times more expensive: ArkType builds an error for every extra key. This is the transformer error path, not the norm; every such response is visible in the logs with `undeclared_key`.
