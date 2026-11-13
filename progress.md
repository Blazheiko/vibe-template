# feat-206: HTTP Core and Cookie Lows

Step S12 of `docs/plan/security-review-2026-11-12-plan.md`. Findings L-5, L-14, L-15, L-16 of
`docs/security/security-review-2026-11-12.md`.

## Current State

Done, ready for review.

## What Changed

- **L-5, session cookie.** `SESSION_COOKIE_HOST_PREFIX=false` in `.env.example` is commented out.
  `validateRuntimeConfig` refuses a production-like start with the prefix off (the message names
  the variable) or with a cookie without `Secure`. `cookie.secure` is `true` whenever
  `appConfig.isProductionLike`, not only when `APP_ENV` is not `local`.
- **L-14, log volume.** `getHeaders` writes one `debug` line per request (`invalid` count and up
  to three names, cut to 64 characters) instead of a `warn` per refused header.
  `Rate limit exceeded` is written at most once per key and limit window; the next line carries
  `suppressed`. New `vendor/utils/rate-limit/log-throttle.ts`, bounded to 10 000 keys.
- **L-15, CSP.** `getAssetCspKind` answers `document` for `.html`, `.htm` and `/`, so an HTML file
  streamed from disk has the same policy as one served from memory.
- **L-16, limit key.** The per-route key is `route:<ip>:<method>:<url>`.

## Files Modified

- `packages/backend/.env.example`
- `packages/backend/src/config/session.ts`
- `packages/backend/src/app/start/validate-runtime-config.ts` (+ spec)
- `packages/backend/src/vendor/utils/network/http-request-handlers.ts`
- `packages/backend/src/vendor/utils/network/invalid-headers-logging.spec.ts` (new)
- `packages/backend/src/vendor/utils/rate-limit/http-rate-limit.ts` (+ spec)
- `packages/backend/src/vendor/utils/rate-limit/log-throttle.ts` (new, + spec)
- `packages/backend/src/vendor/start/static-server.ts`, `static-server-csp.spec.ts`
- `documentation/backend/{auth,configuration,routing,caching-etag,security}.md` and the same
  pages under `documentation/en/backend/`

## Evidence of Completion

- `make check` (format, typecheck, lint, tests): passed. Backend 209 files / 2967 tests,
  frontend 577, api-playground 115.
- `pnpm --filter backend test:pg` with `PG_TEST_URL` and `REDIS_TEST_URL`: 33 files / 319 tests
  passed. `pnpm --filter backend test:redis`: 11 files / 117 tests passed.
- `pnpm docs:build && pnpm docs:verify`: passed.
- Live e2e (`playwright.live.config.ts`, production-like build on port 3100): 14 passed.
- **Negative control.** With the five source files reverted and the new specs kept, 15 tests
  fail: the two start refusals and the Secure cookie (L-5), one line for 100 headers and the cut
  name (L-14), one `Rate limit exceeded` per window (L-14), GET and POST counted apart (L-16),
  HTML / `.htm` / index from disk in the enforcing and report-only modes (L-15).
- **Manual check on the real stack** (`scripts/prod-local.sh`, port 3101, `LOG_LEVEL=debug`):
    - `APP_IS_PRODUCTION=true SESSION_COOKIE_HOST_PREFIX=false`: the process exits with
      `SESSION_COOKIE_HOST_PREFIX=false is forbidden in production-like environments: ...`.
    - A 1.2 MB `big-report.html` put into `public/` (`streamedFromDisk: 1` at start) is answered
      with `content-security-policy: default-src 'self'; ...`; a JS asset still has none.
    - One request with 90 headers with invalid names: HTTP 200, one `DEBUG Invalid headers
skipped` line with `invalid: 90` and three names, no `WARN` line.
    - 25 `POST /api/auth/login` (limit 10 per minute): ten 422, fifteen 429, one
      `Rate limit exceeded` line with `key: "route:127.0.0.1:post:api/auth/login"`.

## Notes

- uWebSockets.js itself answers 400 to a request with more than about 100 headers or with a
  control character in a value, so the live check used 90 headers; the unit test uses 100.
- On the live stack a UTF-8 value (`café`) was not counted as invalid, an invalid name was. The
  finding says "any byte above 0x7E in the value"; that part was not looked into here, since the
  fix does not depend on which headers are refused.
- No environment of this repository runs production-like over plain http: `docker-compose.yml`
  and `scripts/prod-local.sh` set `APP_ENV=local` and `APP_IS_PRODUCTION=false`.

## Next Step

Merge, then mark `feat-206` done on `main`.
