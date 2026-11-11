# feat-178 — Rate Limit Redis Timeout Default

Source: `docs/plan/code-review-2026-11-10-report.md`, «Знайдено під час виконання плану»; owner
decision 2026-11-11 («збільшити ліміт для REDIS»).

## State

Done, waiting for review and merge.

## What changed

- `RATE_LIMIT_REDIS_TIMEOUT_MS` defaults to 500 ms (was 50), the same as the main Redis client's
  `REDIS_COMMAND_TIMEOUT_MS`.
    - At 50 ms a loaded developer machine got intermittent 503s on login and registration: 2 of 5
      live e2e runs. At 1000 ms there were none in 6.
    - The main client, at 500 ms, never failed in the same runs. 500 ms keeps the limiter no slower
      than the sessions.
- A timeout still fails closed (503), and still means "result unknown", so it is not retried.
- `.env.example`, and both locales of `backend/configuration.md` and `backend/security.md`. The
  security page used to call this timeout "short" next to the session client's "longer" one.

## Evidence of Completion

- RED: `validate-runtime-config.spec.ts` «defaults RATE_LIMIT_REDIS_TIMEOUT_MS to 500, as
  REDIS_COMMAND_TIMEOUT_MS» failed on the old default (50).
- The two Redis client tests that pinned 50 ms now pin 500 ms:
    - `redis-rate-limit.spec.ts`;
    - `redis-rate-limit.redis.test.ts`. The server pause is now 1500 ms, longer than the timeout,
      and the command must fail in under 1000 ms.
- `make check`: green (backend 2662, frontend 501, shared 30, playground 111).
- `pnpm --filter backend test:redis` (with `REDIS_TEST_URL`): 116 passed.
- `pnpm --filter frontend test:e2e:live`: 3 runs of 13 passed, no 503. The machine load average was
  7–13, lower than when the 503s happened, so this does not prove the cause.
- `pnpm docs:build && pnpm docs:verify`: passed.
