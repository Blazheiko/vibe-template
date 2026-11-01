# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-063 - Resource Limits (in progress, delivered as several PRs)
**Branch:** `fix/support-admission-review` (review follow-up of part 2: D0 + D1, merged in #207)
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase D

feat-063 is large and its parts are independent, so it is delivered as separate PRs and flipped to `done` only after the last one:

| Part    | What                                                                                                                                         | Status                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| D4      | per-route request body limit, upload routes capped, avatar rate limit                                                                        | merged (#206)                              |
| D0 + D1 | support chat admission contract: `admit()` before `ok`, length cap, per-user throttle, owner-token in-flight lock, `support_chat_error` code | merged (#207); review follow-up in this PR |
| D2      | atomic Redis LLM budget (reserve / reconcile)                                                                                                | after D0 + D1                              |
| D3      | chat history contract: pagination for the UI, a bounded selection for the prompt                                                             | last                                       |

## Status

### Done

- [x] Diagnosis (D0): `support-controller` started the answer with `void supportService.chat(...)` and returned `{ status: 'ok' }` at once, so no check made inside the service could reach the client as a refusal; a message cost several paid model calls with no length cap, no per-user rate and no limit on parallel answers
- [x] Tests first on a real uWebSockets.js server, real WebSocket clients, PostgreSQL and Redis (`support-chat-admission.pg.test.ts`, helper `test-support/ws-test-client.ts`); `support-service.spec.ts` rewritten around `admitChat` / `runChat`; `support-inflight-lock.redis.test.ts` on real Redis
- [x] Admission contract: `supportService.admitOpenChat` / `admitChat` run before `{ status: 'ok' }` (length by schema, per-user throttle through `consumeAuthThrottle`, owner-token in-flight lock); a refusal is the reply (`status: '429'`, reasons `support_rate_limited` / `support_busy`); `runChat` / `runOpenChat` run in the background and release the lock **before** the terminal event
- [x] `support-inflight-lock.ts`: `SET key token NX PX ttl`, release by Lua only if the token is still ours; fixed TTL = 3 × `AI_REQUEST_TIMEOUT_MS` + 10 s (no heartbeat)
- [x] `shared/limits` (schema-free subpath, safe for the frontend): `SUPPORT_MESSAGE_MAX_LENGTH = 4000`; `support_chat_error` gets an optional `code` (`chat_failed`, `open_chat_failed`); frontend guard, store, bus and `SupportView` (maxlength, counter, text restored on refusal)
- [x] Env: `SUPPORT_CHAT_USER_RATE_LIMIT_MAX/_WINDOW_MS` (20 / 60 s), `SUPPORT_OPEN_CHAT_USER_RATE_LIMIT_MAX/_WINDOW_MS` (5 / 60 s)
- [x] Docs: `backend/ai.md` ("Допуск повідомлення"), `backend/websocket.md`, `backend/configuration.md`, `.env.example`

### Behaviour changes to know

- A support chat message or greeting that is refused is answered with `status: '429'` instead of `ok`; the frontend returns the text to the input.
- A message over 4000 characters fails WS validation (`validation_failed`).
- Redis unavailable at admission gives `503`, not `ok`.
- Not done (optional in the plan): disabling the input for `retryAfter` on the frontend.

## Evidence of Completion (part D0 + D1)

| Check                                      | Result                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                                                                                   |
| `pnpm test`                                | backend 1294, frontend 170, api-playground 14, shared 15, docs 26; exit 0                                                                |
| `test:pg` with Redis                       | 89 passed (incl. 10 support chat admission over real WebSocket, PostgreSQL and Redis)                                                    |
| `test:pg` without Redis                    | 52 passed, 37 skipped (the Redis-dependent suites)                                                                                       |
| `test:redis`                               | 68 passed (incl. 7 in-flight lock tests)                                                                                                 |
| `docs:build && docs:verify`                | passed                                                                                                                                   |
| Tests first                                | the admission tests failed on the old controller (always `ok`, no throttle, no lock)                                                     |
| Fixed flake from D4                        | `upload-limits.transport.spec.ts` bound on bytes written by the client (kernel buffer dependent) loosened to well-short-of-50-MiB; 12/12 |

## Review follow-up of #207 (this PR)

An external review of the merged PR found four problems; each was checked against the code and all four were real.

- [x] **HIGH — two answers at once after the lock expired.** The fixed TTL (`3 × AI_REQUEST_TIMEOUT_MS + 10 s`) did not bound the database waits of a run, and a run never checked that it still held the lock. Now the lock is a **lease**: 30 s TTL renewed every 5 s by the live answer (Lua `PEXPIRE` only if the token is ours); when renewals fail (Redis silent: declared lost one interval before expiry; key gone or taken over; `3 × AI_REQUEST_TIMEOUT_MS + 60 s` maximum lifetime) the holder's `lost` signal aborts the provider calls and `throwIfAborted()` runs before every paid step and before saving; the client gets `support_chat_error` with `code: 'chat_interrupted'`
- [x] **MEDIUM — a timeout / reset treated as a refusal.** `websocketApi` rejected the same way for a refusal and for no answer; the frontend rolled the message back and restored the text, so a resend duplicated a message the server had kept. Timeout and reset are now `WsDeliveryUnknownError`; the view re-reads the history and compares the number of such messages before and after (delivered / not delivered / cannot tell)
- [x] **MEDIUM — rollback by position.** The optimistic message is removed by its own id (`removeMessage`); local ids are a counter, not a timestamp; tested with "greeting completes, then the refusal arrives"
- [x] **MEDIUM — Redis outage through the rate-limit client was 500.** `toInternalError` recognised only `RedisUnavailableError`; it now uses `isRedisUnavailable`, which also covers the plain ioredis errors of the second connection. This also fixes the same 500 on every auth throttle caller
- Not changed: the admission reasons and the order throttle → lock (reviewer agreed)

### Evidence of Completion (follow-up)

| Check                                      | Result                                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Tests first                                | 16 backend and 10 frontend tests failed before the change (lease, outage mapping, lost-lock runs, store by id, delivery check)   |
| Mutation: no renewal                       | 2 Redis lease tests + 3 fake-timer lease tests fail                                                                              |
| Mutation: no `throwIfAborted`              | 4 lost-lock run tests fail                                                                                                       |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                                                                           |
| `pnpm test`                                | backend 1311, frontend 183, api-playground 14, shared 15, docs 26; exit 0                                                        |
| `test:pg` with Redis / without             | 89 passed / 52 passed, 37 skipped                                                                                                |
| `test:redis`                               | 73 passed (5 new lease tests on real Redis: kept alive past TTL, taken over, key gone, maximum lifetime, release stops renewals) |
| `docs:build && docs:verify`                | passed                                                                                                                           |

## Notes for Next Session

1. Merge this PR (feat-063 stays `in_progress`); then D2 (atomic Redis LLM budget, needs an ADR) on a new branch; D2 adds the budget reservation inside `admit()` and must release the lock when the budget rejects
2. Do not flip feat-063 to `done` before D0–D3 are merged
