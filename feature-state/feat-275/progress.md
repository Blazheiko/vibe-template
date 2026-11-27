# feat-275 — Vendor Cleanup: progress

Plan: `docs/plan/vendor-cleanup-plan.md`. Branch: `chore/vendor-cleanup`.

## Baseline

- 2026-11-27: `./init.sh` exit 0 on `origin/main` after #896 (entry + plan).

## Steps

- [x] 1. Dead code — `start/validators.ts`, `ValidatorFunction`, the commented-out lines in
      `ws-api-dispatcher.ts`, `isValidUrl` removed (0d74fde).
- [x] 2. `setHeader` replaces (case-insensitive, first spelling and position kept). The new
      `response-data.spec.ts` cases failed on the old `push` (3 of 4) and pass now.
      `http-rate-limit.spec.ts` moved to the real `createResponseData` (green before and after the
      change) and covers both 429 sources: one `Retry-After` and one `X-RateLimit-*` set each,
      4 headers in total (ed5e254).
- [x] 3. One module-level `TextDecoder`; `multipart-parse.spec.ts` (real `getParts`): two Unicode
      fields and a file, green before and after the change (f36e999).
- [x] 4. `toCacheKey` (`path.relative` + `/`), tests for POSIX, win32 and this OS (53a0973).
- [x] 5. `node:crypto`, `#vendor/utils/logger.js` in `s3.ts`, eleven `../` → `#vendor/*`. ESLint:
      bare Node built-ins refused in `packages/backend/src` (tests left out), `#logger` and `../`
      inside vendor; the ADR 0005/0006 paths in a constant that every block repeats (1941cbd).
- [x] 6. Docs (both locales): `backend/controllers.md`, `guide/http-response.md`.

## Evidence of Completion

- `make check` exit 0 (format, typecheck, lint, bundle graph, tests): backend 270 files /
  3952 passed, frontend 1029, landing 103, api-playground 115.
- `pnpm --filter backend build` exit 0.
- `pnpm docs:build && pnpm docs:verify`: `verify-dist: all checks passed`.
- `make test-pg` / `make test-redis`: no DB or Redis code changed (only an import in
  `rate-limit-store.ts`); evidence is the CI jobs `test-pg` / `test-redis` of the PR (links added
  once green).

### Negative lint check (temporary violations, reverted)

`pnpm exec eslint` on `vendor/utils/rate-limit/rate-limit-store.ts` (vendor) and
`app/services/shared/apply-service-status.ts` (app) with appended imports; every one refused:

```
app    13:1 'fs' … Import Node built-ins with the node: prefix: 'node:fs'
app    14:1 '#app/routing/define-raw-route.js' … (ADR 0005)
app    15:1 '#app/routing/define-ws-route.js' … (ADR 0006)
vendor 229:1 'crypto' … Import Node built-ins with the node: prefix: 'node:crypto'
vendor 230:1 '../network/ip-address.js' … by a pattern. Inside vendor import through #vendor/* instead of ../
vendor 231:1 '#logger' … Inside vendor import the logger from #vendor/utils/logger.js
vendor 232:1 '#app/routing/define-raw-route.js' … (ADR 0005)
vendor 233:1 '#app/routing/define-ws-route.js' … (ADR 0006)
```

### Manual golden path (`scripts/prod-local.sh`, `PORT=3456`, `SERVE_STATIC=true`)

PostgreSQL and Redis: throwaway `pgvector/pgvector:pg16` and `redis:7-alpine` containers on
ports 55432 / 56379 (the local 5432 / 6379 belong to another project), `db:create`,
`db:migrate`, `db:seed`; stopped afterwards.

Static (the backend cache, keys through `toCacheKey`):

```
== GET /
HTTP/1.1 200 OK
content-type: text/html; charset=UTF-8
Cache-Control: public, max-age=0, must-revalidate
ETag: "eokZoTDpaeFtjD5PW4FBP8LIDTg"
== GET /some/deep/path
HTTP/1.1 200 OK
content-type: text/html; charset=UTF-8
ETag: "eokZoTDpaeFtjD5PW4FBP8LIDTg"
<!doctype html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />

asset=/assets/index-Brqm5yE6.js
== GET asset
HTTP/1.1 200 OK
Cache-Control: public, max-age=31536000, immutable
ETag: "oDK50iBcBkGca5Ury71-UA1mx7A"
== GET asset If-None-Match: "oDK50iBcBkGca5Ury71-UA1mx7A"
HTTP/1.1 304 Not Modified
ETag: "oDK50iBcBkGca5Ury71-UA1mx7A"
```

Route limit and redirect:

```
== route limit: POST /api/auth/forgot-password x4
#1 HTTP/1.1 403 Forbidden
#2 HTTP/1.1 403 Forbidden
#3 HTTP/1.1 403 Forbidden
#4 HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 3
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1795791763
Retry-After: 60
count retry-after=1 x-ratelimit-limit=1
== redirect: GET /api/auth/oauth/google/redirect
HTTP/1.1 404 Not Found
count location=0
google: HTTP/1.1 302 Found location_count=1 Location: /?error=oauth_failed
github: HTTP/1.1 302 Found location_count=1 Location: /?error=oauth_failed
```

(403 before the limit is the CSRF guard: the rate limit runs before the middlewares. The OAuth
`redirect` route answers 404 with no provider configured; the `callback` error path sets
`Location`.)

Global limit L1 (`HTTP_GLOBAL_RATE_LIMIT_MAX=3`):

```
== L1 (HTTP_GLOBAL_RATE_LIMIT_MAX=3): POST /api/auth/forgot-password x4 (route limit 3)
#1 HTTP/1.1 403 Forbidden
#2 HTTP/1.1 403 Forbidden
#3 HTTP/1.1 403 Forbidden
#4 HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 3
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1795791828
Retry-After: 60
count retry-after=1 x-ratelimit-limit=1 x-ratelimit-remaining=1 x-ratelimit-reset=1
== L1 on a route with its own limit 10: POST /api/auth/reset-password
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 3
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1795791828
Retry-After: 49
count retry-after=1 x-ratelimit-limit=1 x-ratelimit-remaining=1 x-ratelimit-reset=1
```

(`reset-password` has its own limit of 10; `X-RateLimit-Limit: 3` shows the refusal is L1's.)

Deviation from the plan: the avatar upload was not run by hand (needs a signed-in user, CSRF and
S3). Decoding of multipart text fields is covered by `multipart-parse.spec.ts` through the real
`getParts`; the multipart routes by `upload-limits.transport.spec.ts` (real uWS server), green
in `make check`.

## Notes for Next Session

(none)
