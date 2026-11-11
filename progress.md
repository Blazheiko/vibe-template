# feat-165 — Playground Lows (V19)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V19), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (V19.S–V19.X). Low findings of
`docs/plan/code-review-2026-11-10-report.md`. Depends on feat-158.

## State

Done, waiting for review and merge.

## What changed

| Finding                                                     | Before                                                                                                                             | Now                                                                                                                                                |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| average time (`utils/load-test.ts`)                         | wall-clock time of the run / number of requests: with 10 threads it came out ten times below the fastest request                   | the mean of the request durations; no `Infinity` for a run that sent nothing                                                                       |
| bounds and stop (`useLoadTest.ts`, `TestForm.vue`)          | 1000 / 100 only in `min` / `max` of the inputs: a typed 100000 threads ran, `0` requests gave `Infinity`, nothing could stop a run | `clampCount` with `MAX_REQUESTS_PER_THREAD` / `MAX_THREADS` in `run()`; `stop()` and a **Stop** button end the run after the requests on their way |
| empty token (`useWebSocketConnection.ts`)                   | the subprotocol list was `['']`: `new WebSocket` threw `SyntaxError`                                                               | no subprotocol without a token; the previous token is forgotten                                                                                    |
| settings (`ApiSettingsModal.vue`, `stores/api-settings.ts`) | Test Connection did nothing with an empty base URL; a saved `baseUrl` won over `VITE_API_BASE_URL`                                 | the check goes through the Vite proxy; the env value of the build wins, the saved one is a fallback, a typed override still wins for the tab       |
| console (`utils/base-api.ts`, `stores/api-doc.ts`)          | the request body (passwords, tokens) and the whole route doc were logged                                                           | neither is logged                                                                                                                                  |

Docs (both locales): `playground/index.md`.

## Evidence of Completion

### RED (new tests against the old code)

27 failed of 111: the average and Infinity cases of `summaryOf`, `clampCount` (11), the stop of
`executeThread`, three subprotocol cases, the env precedence, the body in the console, four bound
cases and three stop cases of `useLoadTest`. Two tests changed meaning: the old "averages over the
wall-clock time" now expects the mean of the durations.

### After the fix

- `make check`: playground 10 files / 111 tests, frontend 499, backend 2655, shared 30.
- `pnpm docs:build && pnpm docs:verify`: passed.

### Not verified

- The playground was not opened in a browser: the Stop button and Test Connection through the
  proxy were checked by unit tests only.
- The subprotocol test checks the list given to `useWebSocket`; no real `WebSocket` was built.
