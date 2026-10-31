# Session Progress Log

## Current State

**Last Updated:** 2026-10-31
**Active Feature:** feat-056 - Mistral SDK 3
**Branch:** `chore/mistral-v3` (status PR #180: feat-056 → `in_progress`)
**Plan:** `docs/plan/node-24.22.2-uws-20.71-upgrade-plan.md`, PR 3 (D.1)

## v3 changes vs the adapter

Release notes: https://github.com/mistralai/client-ts/releases/tag/v3.0.0 (Speakeasy-generated). We use only `new Mistral({ apiKey })` and `client.chat.stream(...)` in `mistralai-text-adapter.ts`.

| Change                                                                            | Affects us                                           | Action                                  |
| --------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| `EventStream[Symbol.asyncIterator]` now from `ReadableStream`                     | `for await` over the stream                          | none (same iteration)                   |
| `fetchOptions` deprecated, flattened into `RequestOptions`                        | the abort signal was passed as `fetchOptions.signal` | `{ signal }`; adapter test mock updated |
| Removed `Runs`, `SecurityErrorCode`, beta surface (agents, workflows, connectors) | no                                                   | —                                       |
| New dependency `@modelcontextprotocol/sdk`; unpacked size 11.1 → 15.2 MB          | production image grows                               | accepted                                |

## Status

### Done

- [x] `@mistralai/mistralai` 2.7.0 → 3.4.0 (exact pin), signal via flattened request options
- [x] Real SDK 3.4.0 against a local fake SSE server (`serverURL`, scratchpad script, no key): request goes to `/v1/chat/completions` with `Bearer` auth and `max_tokens` / `stream: true`; streamed text «Hello» assembled; `usage` mapped to `promptTokens 7 / completionTokens 2 / totalTokens 9`; a hanging stream with `AbortSignal.timeout(300)` rejects with `TimeoutError` after ~316 ms

### Not done

- Real Mistral API call — no `MISTRAL_API_KEY` here

## Evidence of Completion

| Check                                                | Result                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check` / `build` | exit 0                                                                             |
| `pnpm test`                                          | backend 1174 (AI adapters 28), frontend 168, api-playground 14, shared 14, docs 26 |
| Fake-server SDK check                                | text, usage, request shape, abort — as above                                       |
| `pnpm audit`                                         | 13 → 12 (1 low, 10 moderate, 1 high)                                               |

## Notes for Next Session

1. Merge status PR #180 and the feature PR, then the done-PR
2. The upgrade plan is then complete; open item outside it: main Redis client timeouts under load
