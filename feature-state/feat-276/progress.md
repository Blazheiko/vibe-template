# feat-276 — Vendor Cleanup Review Fixes: progress

Review of #897 (feat-275). Branch: `fix/vendor-cleanup-review`. No plan file: three small fixes,
scope in the `feature_list.json` entry.

## Steps

- [x] 1. Fixed clock in `http-rate-limit.spec.ts`: fake timers at a fixed time for every test, so
      the exact `Retry-After: 60` (two from feat-275, one older) no longer depends on how long the
      test takes. New test: 1.5 s later `Retry-After` is `59`.
- [x] 2. ESLint: the `_` filter goes; the 14 legacy `_http_*` / `_stream_*` / `_tls_*` names
      need `node:` too.
- [x] 3. `main-service.ts` `setHeaderAndCookie` calls `setHeader`; new `main-service.spec.ts`
      fails on the old `push` (two headers after two calls) and passes now.

## Evidence of Completion

- `make check` exit 0: backend 3954, frontend 1029, landing 103, api-playground 115.
- Negative lint check (temporary imports, reverted):

```
 13:1 error '_stream_readable' import is restricted from being used. Import Node built-ins with the node: prefix: 'node:_stream_readable' no-restricted-imports
 14:1 error '#app/routing/define-raw-route.js' import is restricted from being used. Declare the route through its contract: defineRoute from #app/routes/contract-schemas/index.js (ADR 0005) no-restricted-imports
 229:1 error '_http_common' import is restricted from being used. Import Node built-ins with the node: prefix: 'node:_http_common' no-restricted-imports
 230:1 error 'crypto' import is restricted from being used. Import Node built-ins with the node: prefix: 'node:crypto' no-restricted-imports
```

(lines 13–14: `src/app/services/shared/apply-service-status.ts`; 229–230:
`src/vendor/utils/rate-limit/rate-limit-store.ts`.)

- No DB, Redis, route or docs change; `test-pg` / `test-redis` links from the PR CI below.
- Manual golden path: not applicable beyond the tests (test code, a lint rule and a demo route
  header); the demo route header is covered by `main-service.spec.ts`.

## Notes for Next Session

- The first `make check` run failed once in `upload-limits.transport.spec.ts` ("does not buffer
  20 parallel 50 MiB uploads"): one of 20 parallel uploads got `400 Bad Request`, the test
  allows 413 / 429 / reset. Unrelated to feat-276 (files untouched); the spec passed 3 runs alone
  and the rerun of `make check` was green. A flake to look at separately.
