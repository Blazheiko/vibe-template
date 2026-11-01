# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-063 - Resource Limits (in progress, delivered as several PRs)
**Branch:** `fix/resource-limits-multipart` (part 1 of 4)
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase D

feat-063 is large and its parts are independent, so it is delivered as separate PRs and flipped to `done` only after the last one:

| Part    | What                                                                                                                                         | Status        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| D4      | per-route request body limit, upload routes capped, avatar rate limit                                                                        | this PR       |
| D0 + D1 | support chat admission contract: `admit()` before `ok`, length cap, per-user throttle, owner-token in-flight lock, `support_chat_error` code | next          |
| D2      | atomic Redis LLM budget (reserve / reconcile)                                                                                                | after D0 + D1 |
| D3      | chat history contract: pagination for the UI, a bounded selection for the prompt                                                             | last          |

## Status

### Done

- [x] Diagnosis (D4): the body limit of a multipart route was the global `APP_MAX_MULTIPART_BODY_SIZE` (50 MiB) for every route, while the avatar file limit is 10 MiB and the knowledge-base screenshot limit 5 MiB, checked only after the whole body had been read. The early `Content-Length` refusal and the mid-stream abort already existed in `readData`; what was missing was a limit per route
- [x] Tests first (`route-body-limit.transport.spec.ts`, real uWebSockets.js server and raw sockets): a route limit of 1000 bytes was ignored — the `Content-Length` refusal reported the global limit, a 2000-byte chunk passed, the body at the limit +1 byte was accepted
- [x] `maxBodySize` on a route (`RouteConfig`); `resolveMaxBodySize(kind, routeLimit)` = `min(global limit of the kind, route limit)` — a route can only tighten; `routesHandler` fails at startup on `maxBodySize` for a method without a body or a non-positive-integer value; the playground `bodyLimits` shows the effective limit
- [x] `app/services/shared/upload-limits.ts`: `AVATAR_MAX_FILE_BYTES` (10 MiB), `KB_SCREENSHOT_MAX_FILE_BYTES` (5 MiB), `MULTIPART_OVERHEAD_BYTES` (64 KiB), `multipartBodyLimit()`; the services use the same constants; avatar upload `maxBodySize` = 10 MiB + 64 KiB, KB screenshot = 5 MiB + 64 KiB; the avatar group gets a rate limit of 10 per minute per IP
- [x] Real sizes on a real server (`upload-limits.transport.spec.ts`): a file of exactly 10 MiB passes (its framing fits), a body one byte over the limit is `413`, an 11 MiB `Content-Length` is refused from the headers, a chunked 50 MiB body is refused long before its end, 20 parallel 50 MiB uploads are all refused near the limit with bounded memory growth
- [x] Route table spec: every multipart route has its own limit, avatar and screenshot values, avatar rate limit
- [x] Docs: `backend/request-lifecycle.md`, `backend/storage.md`

### Behaviour changes to know

- `POST /avatar/upload` and `POST /admin/knowledge-base/:id/screenshot` refuse a request body over 10 MiB + 64 KiB / 5 MiB + 64 KiB with `413` (before: only the file check, `400`, after up to 50 MiB had been read). A file of exactly the allowed size is still accepted.
- The avatar routes are limited to 10 requests per minute per IP.
- A server that refuses an oversized body while the client is still sending may close the connection; the TCP reset can reach a client before it has read the `413`.

## Evidence of Completion (part D4)

| Check                                      | Result                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| New transport tests before the fix         | 3 of 5 failed (the route limit was ignored)                                      |
| Mutation check (route limit ignored again) | 8 of the 12 transport tests of this part fail, including the 20 parallel uploads |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                           |
| `pnpm test`                                | backend 1281, frontend 168, api-playground 14, shared 14, docs 26; exit 0        |
| `test:pg` with Redis / `test:redis`        | 79 / 61 passed (not affected)                                                    |
| `docs:build && docs:verify`                | passed                                                                           |
| Stability                                  | `upload-limits.transport.spec.ts` 8 runs in a row                                |

## Notes for Next Session

1. Merge this PR (feat-063 stays `in_progress`); then D0 + D1 on a new branch
2. Do not flip feat-063 to `done` before D0–D3 are merged
