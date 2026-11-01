# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-063 - Resource Limits (in progress, delivered as several PRs)
**Branch:** `fix/support-chat-admission` (part 2 of 4: D0 + D1)
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase D

feat-063 is large and its parts are independent, so it is delivered as separate PRs and flipped to `done` only after the last one:

| Part    | What                                                                                                                                         | Status        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| D4      | per-route request body limit, upload routes capped, avatar rate limit                                                                        | merged (#206) |
| D0 + D1 | support chat admission contract: `admit()` before `ok`, length cap, per-user throttle, owner-token in-flight lock, `support_chat_error` code | this PR       |
| D2      | atomic Redis LLM budget (reserve / reconcile)                                                                                                | after D0 + D1 |
| D3      | chat history contract: pagination for the UI, a bounded selection for the prompt                                                             | last          |

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

## Notes for Next Session

1. Merge this PR (feat-063 stays `in_progress`); then D2 (atomic Redis LLM budget, needs an ADR) on a new branch; D2 adds the budget reservation inside `admit()` and must release the lock when the budget rejects
2. Do not flip feat-063 to `done` before D0–D3 are merged
