# feat-158 — Playground Error Reporting (V12)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V12), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (V12.S–V12.X). Finding M7 of
`docs/plan/code-review-2026-11-10-report.md` and the low finding about WebSocket errors shown as a
success.

## Goal

The API playground is where a developer reads why a request was refused, and it hid exactly that.

- HTTP: the body of an answer was parsed only for 422. A 403 from CSRF showed
  `HTTP error! status: 403` without the `reason` the playground's own troubleshooting table tells
  the developer to read. An answer without a JSON body (204, plain text) was reported as a network
  error with status 0.
- WebSocket: the handler read `payload.message` of a reply; the backend's replies have no
  `payload`, so the handler threw, the request sat until its timeout, and `baseApi.ws` turned
  that rejection into a result which the form showed as a green 200.

## State

Done, waiting for review and merge.

## What changed

- `packages/api-playground/src/utils/base-api.ts`
    - `http` reads the JSON body of every answer; an error keeps its body in `data` and takes its
      `message` from it; no body or a non-JSON one is `data: null` and, for a 2xx, a success.
    - `ws` no longer swallows a rejection.
- `packages/api-playground/src/composables/useWebSocketConnection.ts` — an error reply rejects at
  once with `WsRequestError` (`status`, `code`, `message`, the whole `reply`), read from the
  backend's error envelope; a timeout and a connection reset reject with the same class.
- `packages/api-playground/src/components/api/TestFormWs.vue` — shows a failed request as an
  error with the server's reply; the status of a success is the number of the string `'200'`.
- Tests: `utils/__tests__/base-api.spec.ts` (new, 16), `composables/__tests__/ws-request-errors.spec.ts`
  (new, 3).
- Docs (both locales): `playground/index.md`.

## Evidence of Completion

### V12.T — RED (before the fix)

```
 × shows the body of a 403, so the CSRF reason can be read      expected null to deeply equal { status: 'error', … }
 × shows the body of a 400 / 404 / 409 / 413 / 429 / 500 / 503
 × still announces a 401, and shows its body too
 × is a success for a 204, not a network error                  expected undefined to be 204
 × is a success for a 200 that is not JSON
 × does not turn a refused or lost request into a result        promise resolved "{ data: null, … }" instead of rejecting
 × rejects at once with the code and message of an error reply  Test timed out in 5000ms
 × rejects with a timeout when no reply comes
 Tests  14 failed | 5 passed (19)
```

### After the fix

- Playground: 9 files / 81 tests passed; `eslint` and `vue-tsc --build` clean.
- `make check`: backend 2612, frontend 452, shared 27, api-playground 81.
- `pnpm docs:build && pnpm docs:verify`: passed.
- `executeRequest` (`utils/load-test.ts`) already hands `data` of an error answer to the form
  (`data || error.message`), so the body now reaches `TestForm.vue` without a change there.

### Not verified

- No run of the playground in a browser against a backend: the behaviour is covered at the
  client functions; the rendering of `TestFormWs.vue` for a failed request was not looked at.

## Notes for Next Session

- feat-165 (V19) continues with the playground's low findings (load test average, limits, empty
  token, settings, console logging).
