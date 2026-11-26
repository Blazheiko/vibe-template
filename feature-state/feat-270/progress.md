# feat-270 · Branded Types Safety Gaps

Branch: `fix/branded-types-safety-gaps`. Status: implementation done, PR open.

## Changes

1. **MfaBinding** (Р5): `MfaTicket.binding`, `mfaTicketStore.reserve` / `deleteIfOpen` and `continueByRequest` (mfa-sign-in) take `MfaBinding`. New `mfa-ticket.spec.ts` pins it on the real store methods (`@ts-expect-error` for the raw `mfa_bind` value and for bare text).
2. **Typed Redis TTL** (Р7, T39): `app/services/shared/redis-ttl.ts` (`setWithTtlSeconds` EX/`Seconds`, `setIfAbsentWithTtlMs` PX NX/`Milliseconds`, `secondsArg` / `msArg` for Lua ARGV). Used by mfa-ticket, passkey-login-challenges, redis-lease, llm-budget-service, auth-throttle-service, generate-ws-token-service. ESLint `no-restricted-syntax` in `packages/backend/src/app/**` refuses `setex`/`psetex`/`expire`/`pexpire`/`expireat`/`pexpireat`/`getex` and `set(…, 'EX'|'PX'|'EXAT'|'PXAT', …)` outside the helper and tests. Redis test `redis-ttl.redis.test.ts`: real TTL/PTTL of the helpers, a fractional 1.5 s rounded up to 2 s by `toSecondsCeil`, the WS token (60 s), the passwordless challenge (300 s) and the second-step challenge (bounded by its ticket).
3. **UnixSeconds** brand in `shared/brand`; `unixSecondsOf` returns it (an instant, not the `Seconds` duration); `request-session` `nowSeconds()` uses it. Type tests in `app/time-brands.spec.ts`.
4. **Retry-After**: `RateLimitDecision.retryAfterMs` and `retryAfterSeconds()` take `Milliseconds` (seconds can no longer be divided by 1000 twice); `http-rate-limit` uses `toMs(retryAfter)`; `sms-challenge` uses `addMs(now, toMs(…))` with the SMS TTL / cooldown branded `Seconds` in `config/auth.ts`.
5. **OAuth email**: normalized before the empty check, so `'   '` is refused (new test in `oauth-service.spec.ts`, fails without the fix).
6. **Support `before`**: parsed with `parseSupportMessageId` in the controller (400 on null), the service takes `SupportMessageId` (no throwing `asSupportMessageId`); a row in `entity-id-inputs.spec.ts`.
7. **WS token userId** (Р13, T15): `ws-session-auth` checks `typeof` of every field and `parseUserId(userId)` before the session lookup. Unit cases (`abc`, `0`, `007`, `' 1'`, `7`, `null`: no `redis.get`, no `checkSessionToken`; 6 fail without the fix) and `ws-session-auth.redis.test.ts` on a real Redis.

Docs: `documentation/{,en/}backend/repositories.md` (the Redis TTL helpers and the lint rule; `SET … EX`, `PEXPIRE`).

## Evidence of Completion

- `make check`: exit 0 (backend 3917, frontend 1029, landing 103, api-playground 115 tests; one pre-existing frontend lint warning in `e2e/mock/notifications.spec.ts`).
- `REDIS_TEST_URL=redis://127.0.0.1:6379/15 pnpm --filter backend test:redis`: 22 files, 224 passed, 0 skipped.
- `pnpm docs:build && pnpm docs:verify`: all checks passed.
- PG suite: not run locally (no Postgres of this project); see the `test-pg` CI job of the PR.
- Lint rule probe: a temporary file with `redis.set(k, v, 'EX', 1)`, `redis.setex`, `redis.pexpire` in `app/` gave 3 `no-restricted-syntax` errors; `eslint packages/backend/src/app` is clean.
- Golden path: covered by the unit and Redis tests above (MFA ticket reserve with a binding, WS upgrade with a valid token, Retry-After on 429); not run against a live app.

## Notes for Next Session

After merge: "Mark feat-270 done" PR, then feat-271 (depends on feat-270).
