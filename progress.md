# feat-112 — Server Lifecycle

Plan: `docs/plan/code-review-2026-11-03-plan.md`, item R08 (findings 10, 14, 15, 16; after feat-107). Branch: `fix/feat-112-server-lifecycle` (from `main` after #368).

## Current State

Implemented; PR open.

- `server.ts`:
    - `initServer` awaits the listen callback, and a `false` token rejects with `Failed to listen on <unix socket path | http://host:port>`. Startup then logs with `console.error` and exits 1.
    - `stopServer` closes the listen socket first, then `closeAllWs`.
    - The static cache route catches a rejected handler: it logs `Unhandled static cache handler error` and answers 500 if it still can.
- `ws-handlers.ts` `closeAllWs`: every socket is ended with 4201 first (each in its own try). The token revokes then run together with `Promise.allSettled`, and failures are logged as a count.
- `static-server.ts`: both 304 paths use `endWithoutBody()`.
- `validate-runtime-config.ts` `getUnixPathError`:
    - refuses `APP_UNIX_PATH` over the `sun_path` limit (103 bytes on macOS, 107 on Linux);
    - this is needed because uWS aborts natively on such a path: SIGTRAP, exit 133, no log line. This was the silent exit seen during the R07 manual run.
- Docs: `documentation/backend/deployment.md`, `websocket.md`, `configuration.md`.

## Files Modified

- `packages/backend/src/vendor/start/server.ts`, `static-server.ts` + the static specs (fakes get `endWithoutBody`; 304 asserts it)
- `packages/backend/src/vendor/utils/network/ws-handlers.ts`
- `packages/backend/src/app/start/validate-runtime-config.ts` + spec
- New: `packages/backend/src/vendor/start/server-lifecycle.spec.ts`
- `packages/backend/src/app/websocket/ws-registry-lifecycle.pg.test.ts` (shutdown case; unique emails)
- Docs as above.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 2305, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` with Redis: 24 files / 219 passed. `test:redis`: 10 files / 102 passed.
- `server-lifecycle.spec.ts` (real uWS):
    - a missing directory as unix path → `initServer` rejects with the reason;
    - a throwing static cache handler → 500 twice, server alive;
    - after `stopServer` → a new TCP connect is `ECONNREFUSED`.
- `ws-registry-lifecycle.pg.test.ts` (real server, Redis, PostgreSQL): every revoke rejects → both clients get close code 4201, and the listener refuses new connections.
- Static 304 answers end with `endWithoutBody`.
- Mutation check: with `main`'s server, ws-handlers, static-server and validate-runtime-config, 7 unit cases fail plus 2 unhandled errors (the static throw), and the real-server shutdown case fails.
- Probe: uWS `listen_unix` on a missing directory → `false`; on a 210-character path → the process aborts with exit 133.
- Manual (built backend):
    - 210-byte `APP_UNIX_PATH` → exit 1, `Invalid app configuration: APP_UNIX_PATH is 210 bytes; ... at most 103`;
    - `/nonexistent-feat-112/app.sock` → exit 1, `Failed to listen on unix socket ...`;
    - TCP 3417 + SIGTERM → exit 0, logs `stop SIGTERM` / `server stop type: SIGTERM`, and the next connection is refused.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next by the plan order (wave 4): R10 (infra config guards: pg query timeout, readiness probe, Sentry sample rate).
