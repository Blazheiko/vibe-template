# feat-267: Branded Time Units — progress

## Current state

Implementation complete (T37–T42 of `docs/plan/branded-types-tasks.md`), waiting for CI and review.

## What changed

- `shared/brand`: `Milliseconds`, `Seconds`, `UnixMs` and the operations `ms`, `seconds`, `unixMs`,
  `nowUnixMs`, `toMs`, `toSecondsCeil` (durations: TTL, Retry-After), `toSecondsFloor`,
  `unixSecondsOf` (instants), `addMs`, `diffMs`. `Timestamp` / `TimestampSchema` removed (unused).
- Redis TTLs are typed by unit: `EX`/`SETEX` take `Seconds` (WS token, passkey challenges, MFA
  ticket, `mfaTicketStore.ttl()` returns `Seconds`), `PX`/`PEXPIRE` take `Milliseconds` (leases,
  one-time tokens, throttle windows, MFA reservations, LLM budget day key).
- Config: `sessionConfig.age` / `anonAge` renamed to `ageSeconds` / `anonAgeSeconds` (`Seconds`);
  `ThrottlePolicy.windowMs: Milliseconds`, `*_WINDOW_SECONDS` env values converted with
  `toMs(seconds(…))`; `mfaConfig.ticketTtlSeconds` / `reservationTtlSeconds` are `Seconds`.
- `retryAfterSeconds` in `AppError` is `Seconds`; every computation rounds up via `toSecondsCeil`.
- `now: number` parameters in `mfa-ticket.ts`, `sms-challenge.ts`, `scheduler-state.ts` are `UnixMs`.
- Docs: `documentation/backend/auth.md` (uk + en) use the new config names. The scheduler contract
  (`defineJob`, `JobContext`, `withJobLease`) is unchanged, so `scheduled-job` and `scheduler.md`
  need no update.
- New Redis tests: the MFA ticket TTL reaches Redis as seconds (`TTL` 118–120 for `seconds(120)`),
  the lease TTL as milliseconds (`PTTL` 4000–5000 for `ms(5_000)`). Shared: `time-units.test.js`.

## Evidence of Completion

- `make check`: exit 0 — backend 3899 passed, frontend 1029, landing 103, api-playground 115,
  shared and eslint-rule tests pass.
- `pnpm docs:build && pnpm docs:verify`: all checks passed.
- Local Redis (throwaway `redis:7-alpine`): `mfa-ticket.redis.test.ts`, `redis-lease.redis.test.ts`,
  `scheduler/*` — 5 files, 41 passed, 0 skipped.
- `test-pg` / `test-redis` CI jobs: to be recorded from the PR run.
- Golden path: no runtime behaviour change; units are the same numbers as before (verified by the
  TTL/PTTL tests and the unchanged unit suites).

## Notes for Next Session

Record the CI `test-pg` / `test-redis` counts, set `review`, merge, then the "Mark feat-267 done" PR.
feat-268 (PriceInCents etc.) needs owner confirmation before it starts.
