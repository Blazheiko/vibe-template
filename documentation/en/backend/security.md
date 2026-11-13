# Security

This page describes how the backend protects HTTP and WebSocket traffic: rate limiting, CSRF, CORS, security headers and CSP, and client IP detection behind a proxy. How a user signs in and how sessions work is described on the [Authentication](/en/backend/auth) page. Everything below is described from the current code in `packages/backend/src`. For the general order of request handling, see [Request lifecycle](/en/backend/request-lifecycle).

## Rate limiting

Limits work on two levels, and each has a different job.

- **The limit protects the process from frequent heavy operations** (body parsing, middleware, DB queries, AI) → `rateLimit` on a route or group, or the global limit in [`config/rate-limit.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/rate-limit.ts). The counter lives in process memory, and each instance counts separately.
- **The limit applies to a sensitive action** (login, registration, SMS, password reset and change) and must be shared across all instances → a policy in [`config/throttle-policies.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/throttle-policies.ts) and an `enforceThrottle(policy, key, rejected)` step in the service ([`enforce-throttle.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/enforce-throttle.ts)): it consumes one attempt through `consumeAuthThrottle` and returns `ok`, or the `rejected` error when the counter is exhausted (services pass `rateLimited(...)`, that is `429`). When Redis does not respond, the exception is not wrapped and reaches the transport, which answers `503` (fail-closed). The counter lives in Redis.

```
HTTP API:  L1 (memory) → route limit (memory) → handler → auth policies (Redis)
WebSocket: upgrade level 1 (memory) → level 2 (Redis) → auth (onUpgrade) → message limits (memory)
```

### Local limits (in memory, per instance)

| Limit                 | Where it is set                                                                                                                        | Key        | Algorithm    | Window / maximum                                                       | Environment variable       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------ | ---------------------------------------------------------------------- | -------------------------- |
| L1 — all API requests | [`config/rate-limit.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/rate-limit.ts)               | IP         | fixed-window | 60 s / 600                                                             | `HTTP_GLOBAL_RATE_LIMIT_*` |
| HTTP route or group   | `rateLimit` in [`http-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts) | IP + route | sliding-log  | per route, e.g. the `auth` group 60 s / 10, `forgot-password` 60 s / 3 | — (in code)                |
| WS upgrade, level 1   | [`config/rate-limit.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/rate-limit.ts)               | IP         | sliding-log  | 60 s / 120                                                             | `WS_UPGRADE_RATE_LIMIT_*`  |
| WS messages           | `rateLimit` in [`ws-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/ws-routes.ts)     | IP + route | sliding-log  | 60 s / 60–120                                                          | — (in code)                |

- **L1** ([`http-rate-limit.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/rate-limit/http-rate-limit.ts)) counts every API request exactly once: routes, API 404s, `OPTIONS` preflight, and plain HTTP requests to `/<API_PATH_PREFIX>/websocket`. Static files are not counted. On a successful response L1 writes no headers; on 429 it returns `X-RateLimit-*` and `Retry-After`, and the route limit is not checked.
- **The route limit** takes priority over the group limit. The response contains `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`; exceeding the limit gives `429 rate_limited` with `Retry-After`; a counter failure gives `503 rate_limit_unavailable` (fail-closed).
- **Why synchronous and in memory.** In [`server.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/server.ts) both HTTP checks run **before** `res.onData()` is registered: if there were an `await` there, uWS could deliver the body of a small POST before anyone starts reading it, and the request would hang. Redis is asynchronous, so it does not fit these limits. Besides, their job is to protect the process, not to hold an exact budget across the cluster.
- **The budget with N instances** equals N × the maximum. This is a deliberate choice: each process protects itself. If needed, a limit at the edge is provided by the reverse proxy, see [Deployment](/en/backend/deployment#rate-limit-at-the-edge).
- **WS messages** are counted per user, not per connection or IP: otherwise the budget could be multiplied by opening new connections, and users behind one NAT would share it. The number of simultaneous connections is limited separately, per user and per IP ([WebSocket](/en/backend/websocket#limits-and-security)).

**The counter** ([`rate-limit-store.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/rate-limit/rate-limit-store.ts)):

- **Rejected attempts do not spend quota and are not stored.** That is why `Retry-After` is accurate. The per-key state is bounded: a sliding log is at most `max` long, and L1 uses a single counter.
- **The key limit is hard, 100,000.** For a new key, at most the 64 oldest keys are checked; if there is no room, the oldest is evicted. A full GC runs once every 60 s.

::: warning Store overflow
When there are more keys than the limit, **quota strictness is not guaranteed**: FIFO eviction can reset even an active counter. This keeps memory bounded under an attack from a large number of IPs. Eviction writes a `warn` no more than once a minute.
:::

### Shared limits (Redis)

All shared limits are described in the [`config/throttle-policies.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/throttle-policies.ts) registry; the table columns correspond to the `ThrottlePolicy` fields. Services pass only the policy and the key — `consumeAuthThrottle(throttlePolicies.loginIp, ip)` ([`auth-throttle-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/auth-throttle-service.ts)). Fixed-window policies write the key `auth:throttle:<scope>:<key>` (Lua `INCR` + `PEXPIRE` only on the first attempt, so the window counts from the first attempt and rejections do not extend it). `wsUpgradeShared` is a sliding log on a ZSET with the key `rl:upgrade:<ip>` ([`redis-sliding-log.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/rate-limit/redis-sliding-log.ts)), and the time is taken from Redis.

| Policy                    | Operation                                                    | Key           | Algorithm    | Window / maximum                       | Environment variable                                          | On Redis failure                           | Reset         |
| ------------------------- | ------------------------------------------------------------ | ------------- | ------------ | -------------------------------------- | ------------------------------------------------------------- | ------------------------------------------ | ------------- |
| `loginIp`                 | login                                                        | IP            | fixed-window | 15 min / 20                            | `AUTH_LOGIN_MAX_ATTEMPTS_PER_IP`, `AUTH_LOGIN_WINDOW_SECONDS` | reject                                     | —             |
| `loginIdentifier`         | login                                                        | email / phone | fixed-window | 15 min / 40                            | `AUTH_LOGIN_MAX_ATTEMPTS_PER_IDENTIFIER`                      | reject                                     | after success |
| `changePasswordUser`      | password change                                              | user          | fixed-window | 15 min / 10                            | `AUTH_CHANGE_PASSWORD_*`                                      | reject                                     | after success |
| `forgotPasswordIp`        | password reset email                                         | IP            | fixed-window | 1 h / 10                               | `AUTH_FORGOT_PASSWORD_MAX_REQUESTS_PER_IP_PER_HOUR`           | generic response, email is not sent        | —             |
| `forgotPasswordEmail`     | password reset email                                         | email         | fixed-window | 1 h / 3                                | `AUTH_FORGOT_PASSWORD_MAX_REQUESTS_PER_EMAIL_PER_HOUR`        | generic response, email is not sent        | —             |
| `resetPasswordIp`         | password reset by token                                      | IP            | fixed-window | 1 h / 20                               | `AUTH_RESET_PASSWORD_MAX_ATTEMPTS_PER_IP_PER_HOUR`            | reject                                     | —             |
| `verifyEmailIp`           | email verification                                           | IP            | fixed-window | 1 h / 20                               | `AUTH_VERIFY_EMAIL_MAX_ATTEMPTS_PER_IP_PER_HOUR`              | reject                                     | —             |
| `verifyEmailPasswordUser` | password on a registration confirmation link (feat-097)      | user          | fixed-window | 1 h / 5                                | `AUTH_VERIFY_EMAIL_PASSWORD_MAX_ATTEMPTS_PER_HOUR`            | reject                                     | —             |
| `resendVerificationUser`  | resending the verification email                             | user          | fixed-window | 1 h / 3                                | `AUTH_RESEND_VERIFICATION_MAX_PER_USER_PER_HOUR`              | reject                                     | —             |
| `loginUnverifiedResend`   | verification email after login to an unverified account      | user          | fixed-window | 5 min / 1                              | `AUTH_LOGIN_UNVERIFIED_RESEND_INTERVAL_MS`                    | do not send the email (login is still 401) | —             |
| `registerEmailIp`         | email registration                                           | IP            | fixed-window | 1 h / 10                               | `AUTH_EMAIL_REGISTER_MAX_ATTEMPTS_PER_IP_PER_HOUR`            | reject                                     | —             |
| `registerEmailIdentifier` | email registration                                           | email         | fixed-window | 1 h / 3                                | `AUTH_EMAIL_REGISTER_MAX_ATTEMPTS_PER_EMAIL_PER_HOUR`         | reject                                     | —             |
| `registerPhoneIp`         | phone registration                                           | IP            | fixed-window | 1 h / 10                               | `AUTH_SMS_MAX_SENDS_PER_IP_PER_HOUR`                          | reject                                     | —             |
| `smsSendPhone`            | sending SMS (registration, reset, linking — one budget)      | phone         | fixed-window | 1 h / 3                                | `AUTH_SMS_MAX_SENDS_PER_PHONE_PER_HOUR`                       | reject                                     | —             |
| `confirmPhoneIp`          | phone confirmation                                           | IP            | fixed-window | 1 h / 20                               | `AUTH_SMS_MAX_CONFIRM_ATTEMPTS_PER_IP_PER_HOUR`               | reject                                     | —             |
| `resetPhoneIp`            | password reset by phone                                      | IP            | fixed-window | 1 h / 10                               | `AUTH_SMS_MAX_SENDS_PER_IP_PER_HOUR`                          | reject                                     | —             |
| `confirmResetPhoneIp`     | confirming a reset by phone                                  | IP            | fixed-window | 1 h / 20                               | `AUTH_SMS_MAX_CONFIRM_ATTEMPTS_PER_IP_PER_HOUR`               | reject                                     | —             |
| `linkPhoneIp`             | phone linking                                                | IP            | fixed-window | 1 h / 10                               | `AUTH_SMS_MAX_SENDS_PER_IP_PER_HOUR`                          | reject                                     | —             |
| `linkPhoneUser`           | phone linking (feat-117)                                     | user          | fixed-window | 1 h / 3                                | `AUTH_PHONE_LINK_MAX_ATTEMPTS_PER_USER_PER_HOUR`              | reject                                     | —             |
| `confirmLinkPhoneIp`      | confirming phone linking                                     | IP            | fixed-window | 1 h / 20                               | `AUTH_SMS_MAX_CONFIRM_ATTEMPTS_PER_IP_PER_HOUR`               | reject                                     | —             |
| `linkEmailTarget`         | email linking, OAuth-linking emails and first-address emails | email         | fixed-window | 1 h / 3                                | `AUTH_EMAIL_LINK_MAX_ATTEMPTS_PER_TARGET_PER_HOUR`            | reject                                     | —             |
| `linkEmailUser`           | email linking, OAuth-linking emails and first-address emails | user          | fixed-window | 1 h / 3                                | `AUTH_EMAIL_LINK_MAX_ATTEMPTS_PER_USER_PER_HOUR`              | reject                                     | —             |
| `linkEmailUserCooldown`   | pause between linking emails                                 | user          | fixed-window | `AUTH_EMAIL_LINK_COOLDOWN_SECONDS` / 1 | `AUTH_EMAIL_LINK_COOLDOWN_SECONDS`                            | reject                                     | —             |
| `supportOpenChatUser`     | opening the support chat (AI greeting)                       | user          | fixed-window | 60 s / 5                               | `SUPPORT_OPEN_CHAT_USER_RATE_LIMIT_*`                         | reject                                     | —             |
| `supportChatUser`         | support chat message (feat-063)                              | user          | fixed-window | 60 s / 20                              | `SUPPORT_CHAT_USER_RATE_LIMIT_*`                              | reject                                     | —             |
| `wsUpgradeShared`         | WS upgrade, level 2                                          | IP            | sliding-log  | 60 s / 60                              | `WS_UPGRADE_SHARED_RATE_LIMIT_*`                              | pass through, level 1 applies              | —             |

`0` in an auth policy variable is a config error at startup: protection of a sensitive action cannot be disabled. Only `wsUpgradeShared` (`disableable`) can be disabled with a variable (`MAX=0`), e.g. for a single instance.

Shared limits use a separate connection ([`redis-rate-limit.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/redis-rate-limit.ts)) to the same Redis server: no offline queue, no command resending, and the `RATE_LIMIT_REDIS_TIMEOUT_MS` timeout (500 ms by default, as `REDIS_COMMAND_TIMEOUT_MS`: 50 ms gave intermittent 503s on login and registration on a loaded machine). The main session client also works without an offline queue and retries, with the `REDIS_COMMAND_TIMEOUT_MS` timeout (see [Redis failure](#redis-failure)). A timeout means "the result is unknown": the Lua script may have already consumed the attempt, so there is no retry.

### Login policy

- **Every admitted attempt is counted**, atomically and **before** the user lookup: this way there is no "check now, count later" race, and a missing account, a wrong password, or an account without a password all cost the same.
- **The same response** `401 Invalid email or password` for a missing account, a wrong password, an account without a local password (OAuth), and an exhausted budget. The frontend's error text hints at signing in with Google or Facebook.
- **Keys:** the IP and the normalized identifier. The identifier is normalized by the same `resolveLoginKey` function as the user lookup (email — lowercase, phone — E.164). If the identifier cannot be normalized, only the IP is counted.
- **The identifier threshold is higher than the IP threshold**, so that one attacker cannot easily lock someone else's account. The block is not permanent — it lasts until the end of the 15-minute window.
- **After a successful login** only the identifier counter is reset; the IP counter is not (otherwise one's own valid account would zero the IP budget).
- **Lockout risk:** an attacker with many IPs can exhaust the identifier budget and block login to someone else's account for 15 minutes. The mitigation is the higher threshold and the short window.
- Password change works on the same scheme with a per-user budget.

### Redis failure

| Scenario                                                       | WS upgrade, level 2                            | Upgrade authentication                                                                              | Auth policies                                                                                                                |
| -------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Only the limits connection fails (drop, timeout; server is up) | skipped, level 1 applies, `warn` once a minute | works through the main client                                                                       | rejected (fail-closed); `forgot-password` returns a generic response without an email                                        |
| Redis server is unreachable                                    | skipped, level 1 applies                       | **does not work**: upgrade is quickly rejected with `503` and `Retry-After: 1` before `res.upgrade` | the request does not reach them: the session middleware quickly finishes with `503 service_unavailable` and `Retry-After: 1` |

- Skipping level 2 does **not** spend the local budget a second time: level 1 has already consumed the attempt for this upgrade.
- Skipping level 2 does **not** guarantee a WS connection: the token and session check also goes to Redis. If the session is not found, the upgrade is rejected with `401` before `res.upgrade`.
- **Exceeding the budget during a failure:** each instance counts only locally, so up to N × the level 1 threshold of upgrades from one IP is possible per window.
- **Full Redis unavailability stops more than just limits, but it does so fast.** The main session client ([`redis.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/redis.ts), options in [`redis-main-options.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/redis-main-options.ts)) works without an offline queue (`enableOfflineQueue: false`), without resending (`autoResendUnfulfilledCommands: false`, `maxRetriesPerRequest: 0`), and with a `REDIS_COMMAND_TIMEOUT_MS` timeout (500 ms); reconnect runs in the background with a delay of `min(times · 100, 2000)` ms. The `withRedis` wrapper fails immediately without sending a command if the connection is not `ready`. So a request that reads the session gets `503 service_unavailable` with `Retry-After: 1` within milliseconds (connection dropped) or within the timeout (connected but slow Redis), rather than waiting. The first unavailable command aborts the request, and the following ones are not executed.
- **The price of dropping the queue:** a short reconnect also gives `503`, not a short delay; the HTTP client gets `Retry-After: 1`.
- **WS connections are not closed during a failure:** `ping`/`pong` does not depend on Redis, and an application message gets a `service_unavailable` response with its own `event` (see [WebSocket](/en/backend/websocket#dispatcher)).
- **Late execution.** A command already written to the socket may be executed by Redis even after the client got a timeout. The consequences are limited: a process has one connection, so the order of the process's writes is preserved; a late `SETEX` at login will create a session without a cookie that disappears at its TTL; a late `DEL` at logout will delete the session later, and a client that got `503` will retry the logout.
- How the incident is recorded in logs and Sentry — [Observability](/en/backend/observability#redis-failure).
- **After Redis recovers** the shared counter continues from its own state; attempts let through locally during the failure do not reach it.

### How to add a limit

Protecting the process — `rateLimit` on a route (an example from [`http-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts); the route's contract says nothing about limits):

```ts
defineRoute({
    contract: authContracts.forgotPassword,
    handler: AuthController.forgotPassword.bind(AuthController),
    description: 'Request password reset email',
    rateLimit: { windowMs: 60_000, maxRequests: 3 },
}),
```

A sensitive action — a policy in the registry, a call in the service, and a row in the table above:

```ts
// config/throttle-policies.ts
exportReportUser: fixedWindow(
  'export_report_user',
  'user',
  readInt('REPORT_EXPORT_MAX_PER_USER_PER_HOUR', 10),
  HOUR_MS,
),

// service
const throttle = await enforceThrottle(
  throttlePolicies.exportReportUser,
  String(userId),
  rateLimited('Too many export requests. Please try again later.'),
)
if (Result.isError(throttle)) return Result.err(throttle.error)
```

## CSRF

An explanation for beginners — [CSRF in plain words](/en/guide/csrf). Which routes need `csrf_guard` and which do not — [Web routes and public API](/en/backend/web-and-api-routes).

The synchronizer token model is used ([`config/csrf.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/csrf.ts), [`csrf-guard.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/middlewares/csrf-guard.ts), [`csrf-token.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/session/csrf-token.ts)):

- Every session has a `csrfToken`: 32 random bytes encoded in base64url. If an old session has no token, it is added on the next session load.
- `csrf_guard` checks only the `post`, `put`, `patch`, `delete`/`del` methods. The checks run in order, and each can only reject the request, not skip the following ones:
    1. **Fetch Metadata.** `Sec-Fetch-Site: cross-site` → `403` with `reason: fetch_site_cross_site`; an unknown value → `fetch_site_invalid`. `same-origin`, `same-site`, `none`, and a missing header (old browsers, non-browser clients) move on to the next checks.
    2. **Origin/Referer** (below). `Origin: null` and a malformed `Origin` are rejected immediately, without falling back to `Referer`.
    3. **Token** in the `x-csrf-token` header, compared with `timingSafeEqual`.
- `session_web` creates an anonymous session with a token even before `csrf_guard`, so a request without a cookie also has a session and must send its token. An anonymous session lives in a signed cookie and is not written to Redis until it stores data ([Anonymous session](/en/backend/auth#anonymous-session)), so a stream of requests without cookies does not fill Redis. This closes login CSRF: `POST /auth/login` without a token gets `403 token_mismatch` even with the correct `Origin`. The correct cold start is `GET /main/init` → `401` with a cookie and `csrfToken` → `POST /auth/login` with that cookie and token. If there is still no session (a `session_web` failure), the guard rejects the request.
- Supported topology: the frontend and the API on the same origin or on subdomains of the same site. With `SameSite=Lax` the browser does not send the session cookie in a cross-site `fetch`, so deployment across different sites is not supported.
- `Origin`/`Referer` are additionally checked against the `CSRF_ALLOWED_ORIGINS` list (exact origins: scheme, host, port — without a path or a trailing `/`; a malformed item stops startup). In production-like environments (`APP_ENV`/`NODE_ENV` = `production`/`prod` or `APP_IS_PRODUCTION=true`) the list is required — without it the server does not start. Outside production an empty list is replaced by the origins from `APP_URL` and `FRONTEND_URL`; if those are not set either, any well-formed origin passes the list check. The server warns about both cases at startup.
- `CSRF_STRICT_ORIGIN` defaults to `true`: unsafe requests without `Origin` and without `Referer` are rejected. Browsers always send `Origin` for `fetch` with POST/PUT/PATCH/DELETE.
- `CSRF_ENFORCE` defaults to `true`: violations get `403` with the code `csrf_invalid` and a `reason` field (`fetch_site_cross_site`, `fetch_site_invalid`, `origin_mismatch` or `token_mismatch`; the list is `CsrfRejectReason` in `shared/errors`). `CSRF_ENFORCE=false` is a report-only mode for diagnostics and rollback: violations are only logged (`CSRF validation failed`), and the request goes on. Protection is on by default, so it can only be turned off with an explicit value (`false`, `0`, `no` or `off`), and the server warns about such disabling at startup in any environment, not only production-like ones. It warns the same way about `CSRF_STRICT_ORIGIN=false`. The variable is read at startup, so switching requires a restart.
- `session_web` adds `csrfToken` to responses produced by the middleware chain (401 from `auth_guard`, 403 from `csrf_guard`). Thanks to this, an anonymous client gets a token for the login request.

## CORS

[`config/cors.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/cors.ts) defines the settings, and `setCorsHeader` in [`server.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/server.ts) applies them:

- `ENABLED_CORS` defaults to `false`.
- `CORS_ALLOWED_ORIGINS` is a list of allowed origins with an exact match, no wildcards. `Access-Control-Allow-Origin` reflects the request's `Origin` only when it is in the list. An empty list forbids all cross-origin requests.
- A `404` for an unknown path gets the CORS headers too (otherwise a cross-origin SPA would see "Failed to fetch" instead of `not_found`), and `Access-Control-Expose-Headers` is a comma-separated list (feat-159).
- `Access-Control-Allow-Credentials: true` is sent only with `CREDENTIONALS_CORS=true` (the variable name is spelled exactly like that, with a typo) and only for origins in the list.
- The server always sends `Vary: Origin`. A preflight `OPTIONS` gets `200` with CORS headers.

## Security headers and CSP

[`http-response-handlers.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/network/http-response-handlers.ts) (`setSecurityHeaders`) adds the following headers to every response — JSON API, errors, CORS `OPTIONS`, the SPA HTML shell, and static files: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `Strict-Transport-Security: max-age=31536000; includeSubDomains`, plus CSP according to the rules below.

Static files ([`static-server.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/static-server.ts)) are loaded into memory at startup from an allowlist of extensions, without files that start with a dot. Requests with `..`, `%2e%2e`, `\0` or `%00` get `400`.

### Content-Security-Policy

The policy is built by [`config/csp.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/csp.ts) from the functions in [`vendor/utils/network/csp.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/network/csp.ts). The header values are computed **once at startup**.

| Response                                                 | Policy                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| HTML: `/`, `/index.html`, SPA fallback, both 200 and 304 | the full document policy (below)                                        |
| SVG from static files, 200 and 304                       | `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'` |
| `/service-worker.js`                                     | **no CSP**                                                              |
| other JS, CSS, fonts, images                             | no CSP (the browser ignores it for subresources)                        |
| API JSON, errors, static 400/404, CORS `OPTIONS`         | `default-src 'none'; frame-ancestors 'none'`                            |

The document policy:

```text
default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none';
form-action 'self'; script-src 'self';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com;
img-src 'self' data: blob: <CDN_URL origin> <CSP_EXTRA_IMG_SRC>;
font-src 'self' data: https://fonts.gstatic.com;
connect-src 'self' <API origin> <WS origin> <CSP_SENTRY_ORIGIN> <CSP_EXTRA_CONNECT_SRC>;
upgrade-insecure-requests          # production-like mode only
report-uri <CSP_REPORT_URI>        # if set
```

Outside production-like mode, `connect-src` additionally allows `ws://localhost:*` and `ws://127.0.0.1:*` (Vite HMR).

**Modes.** One mode applies to all response types:

| `CSP_ENABLED` | `CSP_REPORT_ONLY` | Result                                                                              |
| ------------- | ----------------- | ----------------------------------------------------------------------------------- |
| `false`       | any               | no global CSP is sent anywhere                                                      |
| `true`        | `false`           | `Content-Security-Policy`                                                           |
| `true`        | `true`            | `Content-Security-Policy-Report-Only` for all responses, no global enforcing policy |

Several policies apply independently ([CSP3, multiple policies](https://www.w3.org/TR/CSP3/#multiple-policies)), so in report-only mode no global enforcing policy is sent — otherwise it would block the app despite the observation mode. Without `CSP_REPORT_URI`, violations are visible only in DevTools; for centralized collection you need an external receiver. `upgrade-insecure-requests` is ignored in Report-Only.

**A route's own policy.** If a controller itself sets `Content-Security-Policy` or `Content-Security-Policy-Report-Only` (`responseData.setHeader`), the global policy is not written for that response. The controller's header is sent as is, even with `CSP_ENABLED=false` and in report-only mode: the flags control only the global policies.

**Origins.** They are taken from the addresses the browser actually uses:

- API — `CSP_API_ORIGIN`, by default the origin of `APP_URL`. It must match the frontend's `VITE_BASE_URL`.
- WebSocket — the origin of the `getWsUrl()` result ([`get-ws-url-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/communication/get-ws-url-service.ts): `DOMAIN`, `APP_ENV`, `API_PATH_PREFIX`), the very address the API gives to the client as `wsUrl`. Override with `CSP_WS_ORIGIN`.
- Media — the origin of `CDN_URL` (the client receives it as `cdnUrl`). This is the only image source outside `'self'`: the support chat and other screens serve media only from our CDN, not from presigned S3 URLs (see [Storage](/en/backend/storage)). Requests to S3 made only by the backend are not needed in `connect-src`.
- Sentry — `CSP_SENTRY_ORIGIN` (the origin from `VITE_SENTRY_DSN`).

An invalid value (not an origin, wrong scheme, `;`, `,` or a space) stops startup through `validateRuntimeConfig()`.

**Why there is no `'unsafe-inline'` in `script-src`.** The Vite build has no inline scripts; the only inline block in `index.html` is `application/ld+json`, which `script-src` does not affect. `eval` / `new Function` are also forbidden: the frontend does not import ArkType at runtime (ArkType's JIT check calls `new Function`), so WS payloads are validated by the guards from [`ws-payload-guards.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/ws-payload-guards.ts), and `ErrorCodeSchema` was moved from `shared/errors` to `shared/responses`. The e2e test `test:e2e:csp` fails on any CSP violation, so bringing ArkType back into the bundle will be noticed.

::: warning HTML without the backend
When `SERVE_STATIC=false`, HTML is served by the reverse proxy or a CDN, and the CSP for the document must be configured there (see [Deployment](/en/backend/deployment#csp-when-a-proxy-serves-the-frontend)). In that case the backend sets only the strict policy on the API.
:::

## Account pre-hijacking

An attacker can create an account with the victim's address in advance (with a password, through a provider that does not verify the address, with their own phone) and wait until the victim arrives through OAuth or confirms an email they did not request. The protection rests on one rule: an address is considered proven only by proof of mailbox ownership, and the first such proof on an unverified account takes away from the previous owner everything they configured ([plan](https://github.com/Blazheiko/vibe-template/blob/main/docs/plan/oauth-pre-hijack-plan.md)).

| Proof                                       | Who must click                                              | Guarantee                                                                            |
| ------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Google login for Gmail / a Workspace domain | —                                                           | Google owns the mailbox; the claim happens immediately                               |
| The "link the provider" email               | the browser where the OAuth login started (session id hash) | another browser gets `403 oauth_link_wrong_session`, nothing is linked               |
| The first-address confirmation email        | any valid session of the account that requested it          | a victim's click without a session of this account — `403 email_link_wrong_session`  |
| The registration confirmation email         | whoever knows the account password (or has its session)     | the victim's click does not confirm the attacker's account — `403 password_required` |
| Password reset by email                     | anyone with access to the mailbox                           | on an unverified account this is a claim                                             |

The claim runs in one transaction under a lock on the user row: the password and phone are cleared, OAuth links and push subscriptions are deleted, pending tokens and SMS challenges are invalidated, and `session_token` is rotated. Requests admitted before the claim cannot bring access back: a login through an existing link checks it under the same lock, and credential changes from a session verify the presented token ([Authentication](/en/backend/auth#credential-changes-from-a-session)). Details — [OAuth](/en/backend/oauth#linking-by-email).

## Trust proxy and IP detection

[`config/network.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/network.ts) and [`get-ip.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/network/get-ip.ts):

- `TRUST_PROXY` defaults to `false`. Then the client IP is the socket's remote address, and headers are ignored.
- If `TRUST_PROXY=true`, headers are trusted only when the remote address is in `TRUSTED_PROXY_CIDRS` (IPv4, IPv6 and IPv4-mapped addresses are supported; an entry without a prefix is one address, compared as a number, so `::1` matches the peer in any IPv6 spelling, feat-159; a CIDR written in IPv4-mapped form, like `::ffff:a00:0/104`, is an IPv4 network with the prefix minus 96, i.e. `10.0.0.0/8`, feat-130). The prefix is read strictly (feat-132): only 1–3 decimal digits within the address length (96–128 for IPv4-mapped). An entry that is not an address or such a CIDR is a configuration error, and the server does not start: previously `10.0.0.0/`, `10.0.0.0/ 0` or `10.0.0.0/.0` were read as `/0` and made any client trusted, so a forged `X-Forwarded-For` bypassed all per-IP limits. The `X-Forwarded-For` chain together with the remote address is walked right to left, and the client is the first address that does not belong to a trusted proxy. An entry with a port (`203.0.113.7:51234`, `[2001:db8::7]:443`), which some proxies append, is read as an address. On an entry that could not be parsed the walk **stops** (feat-122): everything to its left was written by whoever sent that entry, so it proves nothing, and letting it through would hand the win to a forged left-hand entry. If no client is found, `X-Real-IP` is used, then the remote address. Address parsing never throws (feat-131): it works on text written by the client, synchronously in uWS handlers, so an exception would stop the process. An IPv6 zone id (`fe80::1%eth0`, `::%1`) denotes an interface of the machine that wrote it, not part of the address, so it is discarded; an empty zone id or a zone id on IPv4 is not an address. A WebSocket upgrade answers `500` to any unexpected error instead of a rejected promise, which uWS does not wait for. An `X-Forwarded-For` header sent as several lines (a proxy that adds its own line instead of appending to the client's, like HAProxy with `option forwardfor`) is read in full, the lines in order (feat-130): uWS `getHeader` returns only the first one, and then the chain would be the line written by the client.
- **Unix socket (feat-110).** On `APP_UNIX_PATH` uWS does not provide a peer address. An empty address proves nothing by itself. Only if the server really listens on `APP_UNIX_PATH` **and** `TRUST_UNIX_SOCKET_PROXY=true`, the client is taken from `X-Forwarded-For` (right to left, skipping `TRUSTED_PROXY_CIDRS`, the same entry rules), then from `X-Real-IP`. Otherwise the client is `unknown`. Here `TRUSTED_PROXY_CIDRS` apply independently of `TRUST_PROXY` (feat-122): trust is enabled by `TRUST_UNIX_SOCKET_PROXY`, and the CIDRs name the proxies in front of the socket's proxy (a CDN, a load balancer). `TRUST_PROXY` concerns only TCP.
- **Limit key (feat-110).** Per-IP limits and throttling count not the address itself but the key [`rateLimitKeyForIp`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/network/ip-address.ts): IPv4 (and IPv4-mapped IPv6 in any notation: `::ffff:127.0.0.1`, `::ffff:7f00:1` or `0000:0000:0000:0000:0000:ffff:7f00:0001`, as uWS sees an IPv4 client on dual-stack `HOST=::`, feat-121) is the address itself, and IPv6 is its /64 network in canonical form (`2001:db8:1:2::/64` for any notation of any address within it). Otherwise a regular /64 would give an attacker a new budget for every address. Logs, `user_online` and the session store the full address.
- This IP is used by rate limiting and throttling. If `TRUST_PROXY` is configured incorrectly behind a reverse proxy, all clients share a limit by the proxy's IP. In production-like mode startup writes a `warn` if `TRUST_PROXY=false` or `TRUST_PROXY=true` with an empty `TRUSTED_PROXY_CIDRS`, and on a unix socket if `TRUST_UNIX_SOCKET_PROXY=true` is missing ([validate-runtime-config.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/start/validate-runtime-config.ts)).

## Security audit

The initial backend audit (15 findings) is closed: the status of each finding — the fix, the commit or PR, the test — is in [docs/security/security-analysis-status.md](https://github.com/Blazheiko/vibe-template/blob/main/docs/security/security-analysis-status.md). Each fix is verified by a regression test (feat-040).

## Production checklist

The checklist is compiled from the configuration code (see also [Configuration](/en/backend/configuration)):

- `APP_KEY`: a random string of at least 32 characters, for example `APP_KEY=<openssl rand -hex 32>`. Without it the server does not start.
- `APP_ENV` must not equal `local`, because otherwise cookies lose `Secure`, and 500 error text includes details.
- `APP_URL=https://...`. Keep `SESSION_COOKIE_HOST_PREFIX` enabled (it is by default with `APP_ENV=production`/`prod` or `APP_IS_PRODUCTION=true`).
- `CSRF_ALLOWED_ORIGINS=https://app.example.com` — required, otherwise the server does not start. Leave `CSRF_ENFORCE` and `CSRF_STRICT_ORIGIN` at their defaults (`true`).
- CORS: either `ENABLED_CORS=false` or an explicit `CORS_ALLOWED_ORIGINS`. Enable `CREDENTIONALS_CORS=true` only if needed.
- Behind a reverse proxy: `TRUST_PROXY=true` and an exact `TRUSTED_PROXY_CIDRS`.
- Phone login: a real `AUTH_SMS_PROVIDER` and an `AUTH_OTP_HMAC_KEY` of at least 32 characters. `fake` in production is forbidden by the code.
- OAuth keys (`GOOGLE_CLIENT_SECRET=<secret>` and so on) and `*_REDIRECT_URI` on https.
- CSP: keep `CSP_ENABLED=true`. Set `CSP_API_ORIGIN`, `CSP_WS_ORIGIN` (behind a proxy), `CSP_SENTRY_ORIGIN` if the addresses differ from `APP_URL` / `getWsUrl()`. The first deploy can be done with `CSP_REPORT_ONLY=true` and `CSP_REPORT_URI`.
- Do not enable `DOC_PAGE`: the `/doc/routes` endpoint is registered only with `APP_ENV=manual-test`.
