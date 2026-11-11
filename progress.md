# feat-165 — Playground Lows (V19)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V19), tasks: V19.S–V19.X.

## State

In progress. Code and tests for V19.1–V19.5 are written; `make check` fails on typecheck only.

## Done

- average of request durations, `clampCount` + `MAX_*` bounds, `stop()` and a Stop button;
- no empty WebSocket subprotocol; no request body in the console; `console.log('data')` removed;
- Test Connection works with an empty base URL; `VITE_API_BASE_URL` wins over a saved `baseUrl`.
- RED: 27 new tests failed on the old code; the package suite is 111 passed on the new code.

## Next step

See `session-handoff.md`.
