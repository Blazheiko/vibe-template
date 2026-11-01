# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-063 - Resource Limits (in progress, delivered as several PRs)
**Branch:** `fix/chat-history-contract` (part 4 of 4: D3)
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase D

feat-063 is large and its parts are independent, so it is delivered as separate PRs and flipped to `done` only after the last one:

| Part    | What                                                                              | Status        |
| ------- | --------------------------------------------------------------------------------- | ------------- |
| D4      | per-route request body limit, upload routes capped, avatar rate limit             | merged (#206) |
| D0 + D1 | support chat admission contract, lease lock, idempotent resend (#207, #208, #209) | merged        |
| D2      | atomic Redis daily LLM token budget (ADR 0003)                                    | merged (#210) |
| D3      | chat history contract: a page at a time for the UI, a fixed slice for the prompt  | this PR       |

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

## Second review follow-up (#208 → this PR)

A second external review of the merged #208 found two more problems; both were real.

- [x] **HIGH — a run still spoke after it lost its lease.** There was no check after the `INSERT` of the answer, so the notification and `support_chat_complete` of the old run reached the client and could end the answer of the request that took the lock over; nor before each token broadcast. Now `admission.lost.throwIfAborted()` runs before every token and after the answer is saved (before the notification and the `complete`); the events of an answer carry the `clientMessageId` of its message and the view ignores events of another answer. The connection signal is deliberately not used after the save: a closed tab must still get the push notification. A write that has started cannot be cancelled; the docs say so
- [x] **MEDIUM — "not in the history" was read as "not delivered".** The original `INSERT` may still be waiting when the `SELECT` returns the old history; a retry then duplicates. Comparing texts cannot be made reliable, so `confirmDelivery` / `countUserMessages` are gone. The client now gives each message a `clientMessageId`; the server stores a user message once per `(user_id, client_message_id)` (migration `20261101093458_support_client_message_id`: nullable `varchar(64)` column and a unique index, `INSERT … ON CONFLICT DO NOTHING`; NULLs do not collide, so old clients still work). A lost answer is answered by sending the same request once more; a duplicate gets `support_chat_error` with `code: 'message_already_received'` and no second answer. If the resend is not accepted either, the message stays in the conversation as unconfirmed and the text is not put back

### Evidence of Completion (second follow-up)

| Check                                      | Result                                                                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests first                                | 9 service tests failed before the change (events after a lost lease, id on events, duplicate); the repository, shared and frontend tests were written first |
| Mutation: no `ON CONFLICT DO NOTHING`      | 4 tests fail (3 repository, 1 end-to-end resend)                                                                                                            |
| Mutation: no `lost` checks                 | 3 service tests fail                                                                                                                                        |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                                                                                                      |
| `pnpm test`                                | backend 1318, frontend 194, api-playground 14, shared 16, docs 26; exit 0                                                                                   |
| `test:pg` with Redis / without             | 99 passed / 57 passed, 42 skipped (new: 5 repository tests incl. 10 concurrent inserts, 5 end-to-end resend tests on a real WebSocket server)               |
| `test:redis`                               | 73 passed                                                                                                                                                   |
| `docs:build && docs:verify`                | passed                                                                                                                                                      |

## Part D2 — daily LLM token budget (this PR)

### Done

- [x] Diagnosis: nothing bounded the **cost** of the support chat. D0/D1 limit count, length and parallelism, but 20 messages a minute of 4000 characters is unbounded spend a day; `llm_text_usage` is written after the fact, asynchronously, and may hold `NULL` tokens, so it cannot answer "may this run start?"
- [x] [ADR 0003](docs/adr/0003-llm-budget-reservation.md) (status: proposed — awaiting the owner's explicit acceptance): Redis-only enforcement, atomic reserve, per-call settlement rules, rollback of the lock on refusal, why there is `AI_SUPPORT_PROMPT_ALLOWANCE_TOKENS` and no `AI_BUDGET_RESERVE_RATIO`
- [x] Tests first: `llm-budget-service.redis.test.ts` (16, real Redis: atomic reserve incl. 20 parallel, clamp, per-user/day, midnight `retryAfter`, settle rules, settle on the reserved day, never below zero, TTL kept), `llm-budget-service.spec.ts` (Redis failures), `support-budget.spec.ts` (estimate), config and startup specs, service spec (admission order, rollback of the lock, 503, settle-before-unlock, `begin` before each call, usage hooks), 4 end-to-end tests on a real WebSocket server
- [x] `llm-budget-service.ts`: `reserveDailyTokens` (Lua check-and-add on `llm:budget:<userId>:<UTC day>`, TTL 48 h) → `TokenReservation` (`begin` / `record` / `settle`); not started → refunded, started with usage → actual, started without usage → estimate stays; settle never throws and can be retried; strict rate-limit Redis client (fail-closed)
- [x] `support-budget.ts` (estimate: `ceil(chars/2)` per call + output limits + prompt allowance); `admit()` reserves after the throttle and the lock, a refusal gives the lock back (`429 support_budget_exceeded`, `retryAfterSeconds` to UTC midnight); `release()` settles, then unlocks; the run marks `begin` before each paid call and reports usage through a new `onUsage` hook of the usage recorder, the translation and the embedding search
- [x] Config: `AI_SUPPORT_DAILY_TOKEN_BUDGET` (200000; `0` = off, refused at startup in production-like environments), `AI_SUPPORT_PROMPT_ALLOWANCE_TOKENS` (8000)
- [x] Docs: `backend/ai.md`, `backend/configuration.md`, `.env.example`

### Behaviour changes to know

- A user over their daily budget gets `429` with `reason: support_budget_exceeded` instead of an answer. Default 200000 tokens a day.
- The guarantee is approximate by design (heuristic estimate, settled both ways); documented in the ADR and `ai.md`.
- Production-like environments refuse `AI_SUPPORT_DAILY_TOKEN_BUDGET=0` at startup.
- Not done (optional in the plan): an admin endpoint to view/reset a budget.

### Evidence of Completion (part D2)

| Check                                      | Result                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Tests first                                | budget module absent (suite could not load); 10 service tests, 1 hook test failed before the wiring |
| Mutation: refusal keeps the lock           | 1 service test + 1 end-to-end test fail                                                             |
| Mutation: `release()` does not settle      | 1 service test + 3 end-to-end tests fail                                                            |
| Mutation: a cut-off call is free           | 3 Redis tests + 1 end-to-end test fail                                                              |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                                              |
| `pnpm test`                                | backend 1355, frontend 194, api-playground 14, shared 16, docs 26; exit 0                           |
| `test:pg` with Redis / without             | 104 passed / 57 passed, 47 skipped                                                                  |
| `test:redis`                               | 89 passed                                                                                           |
| `docs:build && docs:verify`                | passed                                                                                              |

## Part D3 — chat history contract (this PR)

### Done

- [x] Diagnosis: `GET /support/chat/history` returned the **whole** conversation (`findChatHistory(userId)` without a limit), while the prompt took the last 20 through the same method with a limit; ordering was by `created_at`, which ties for rows inserted in one millisecond. The plan asked for no silent truncation of the UI
- [x] Tests first: shared contract (query schema bounds, cursor), repository on PostgreSQL (pages, walk back, exact rest, other users, equal timestamps, context slice, `hasChatHistory`), the service spec, 17 HTTP tests on a real server (long conversation, walking 120 messages back in 3 pages, bounds, bad cursor, another user's cursor, 401), the store (latest page, earlier page in front, dedupe, server cursor only, one page at a time, failures keep the list)
- [x] Repository: `findChatHistoryPage(userId, { before, limit })` (ordered by `id`, `limit + 1` to know `hasMore`), `findRecentForContext(userId, 20)`, `hasChatHistory(userId)`; the unbounded `findChatHistory` is gone
- [x] `GET /support/chat/history?before=<id>&limit=<1..100, default 50>`: `SupportChatHistoryQuerySchema` (422 on a bad value), the response gains `hasMore`; `SUPPORT_HISTORY_DEFAULT_PAGE_SIZE` / `SUPPORT_HISTORY_MAX_PAGE_SIZE` in `shared/limits`
- [x] Prompt: `SUPPORT_CONTEXT_MESSAGES = 20` is its own constant, not a side effect of a page size
- [x] Frontend: `supportApi.getChatHistory` returns a page or `null` (a failed read is no longer an empty conversation that wipes the list); store `loadEarlier()` with `hasMoreHistory` / `isLoadingEarlier`; a "Show earlier messages" button in `SupportView` that keeps the scroll position
- [x] Docs: `backend/ai.md` ("Історія чату")

### Behaviour changes to know

- A request without parameters no longer returns the whole history: the latest 50 messages and `hasMore`. A client that ignores `hasMore` sees only the tail of a long conversation.
- A failed history read no longer replaces the conversation with an empty list; the error is shown and the list stays.
- Decision taken without waiting for the owner (the plan listed it as needing one): the UI pagination is a "Show earlier messages" button, not infinite scroll.
- Noticed, not changed (out of scope): `runChat` drops from the prompt every earlier user message whose text equals the current one (`m.content !== message`); excluding the current row by id would be exact.

### Evidence of Completion (part D3)

| Check                                      | Result                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| Mutation: cursor ignored                   | 2 tests fail (repository walk, HTTP walk)                                 |
| Mutation: cursor = first message in store  | 1 store test fails                                                        |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                    |
| `pnpm test`                                | backend 1359, frontend 203, api-playground 14, shared 17, docs 26; exit 0 |
| `test:pg` with Redis / without             | 130 passed / 66 passed, 64 skipped                                        |
| `test:redis`                               | 89 passed                                                                 |
| `docs:build && docs:verify`                | passed                                                                    |

## Notes for Next Session

1. Merge this PR; then a PR to `main` that flips feat-063 to `done` with this evidence (feature_list.json lives only on main). ADR 0003 is still proposed
2. After that: phase E (feat-064)
