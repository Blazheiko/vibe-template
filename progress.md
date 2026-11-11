# feat-159 — Backend Core Lows (V13)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V13), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (V13.S–V13.X). Four low findings of
`docs/plan/code-review-2026-11-10-report.md` ("Бекенд: ядро").

## State

Done, waiting for review and merge. Each finding was reproduced on its own.

## What changed

| Finding                              | Before                                                                                                                                                                                                   | Now                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `vendor/utils/network/ip-address.ts` | an entry of `TRUSTED_PROXY_CIDRS` without a prefix was compared as text, so `::1` never matched a peer written in full form: the proxy was not trusted and every client shared its address in the limits | compared as numbers (`parseIp`), the same as `::1/128`                                                   |
| `vendor/start/server.ts`             | the 404 of the fallback route carried no CORS headers: a cross-origin SPA saw "Failed to fetch"                                                                                                          | both 404s pass the request's origin                                                                      |
| `config/cors.ts`                     | `Access-Control-Expose-Headers` was space-separated (not a valid list)                                                                                                                                   | comma-separated                                                                                          |
| `database/readiness-probe.ts`        | a `/ready` ping arriving while one was in flight was refused: a healthy instance answered 503 to one of two simultaneous checkers                                                                        | concurrent pings share the one query and its outcome; still one connection. `ProbeInFlightError` is gone |

Docs (both locales): `backend/security.md`, `backend/observability.md`.

## Evidence of Completion

### RED (before the fix)

```
ip-address.spec.ts
 × 0000:0000:0000:0000:0000:0000:0000:0001 is ::1 → true        (and three more spellings)
 × agrees with the same address written as a /128
server-rate-limit.spec.ts
 × an unknown API path answers 404 with the allowed origin       expected [] to deeply equal [ 'https://app.test' ]
 × an unknown path outside the API answers 404 with the allowed origin too
 × exposes headers as a comma-separated list
readiness-probe.pg.test.ts (the new test against the old probe)
 × a healthy database: concurrent pings are all ready, over one connection
   expected [ 'fulfilled', 'rejected', …(4) ] to deeply equal [ 'fulfilled', 'fulfilled', …(4) ]
```

### After the fix

- The three specs: 120 passed; `readiness-probe.pg.test.ts`: 5 passed (a stuck statement: all
  concurrent pings fail within the deadline over one connection, then recovery).
- `make check`: backend 195 files / 2633 tests, frontend 467, shared 29, playground 81.
- `pnpm --filter backend test:pg` with `REDIS_TEST_URL`: 31 files / 289 passed.
- `pnpm docs:build && pnpm docs:verify`: passed.

### Not verified

- The form in which uWebSockets.js reports an IPv6 peer was not captured from a live server: the
  fix does not depend on it (any spelling of the same address matches now).
- No browser check of the CORS answer.

## Behaviour change to review

`/ready` against a stuck database: a second request used to be answered "not ready" at once; it
now waits for the probe in flight and gets its outcome, at most `READINESS_CHECK_TIMEOUT_MS`
later. This replaces a recorded choice of feat-113 ("one probe at a time: the next answers not
ready at once"); the one-connection guarantee is kept and tested.
