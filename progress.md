# feat-124 — WebSocket Send and Presence (G4)

Plan: `docs/plan/code-review-2026-11-03-plan.md`, «Четверте рев'ю 2026-11-04», G4; start #405. Branch: `fix/feat-124-ws-send-presence`.

## Current State

Implemented; PR open.

- **L9** (`broadcast-service.ts`):
    - `deliver()` treats uWS `send` 0 (buffered) and 1 as delivered;
    - on 2 (dropped) it logs a warn and `end(1013, 'Backpressure')`, as `sendJson` does;
    - `support-service.ts` `broadcastToConnection` sends to every tab only when the asking connection is no longer in the registry. Before, a buffered send counted as failed and duplicated the tokens on every tab.
- **`sendJson`** takes the connection's `userData` on the message paths and sends nothing (debug only) once `userData.closed` is set, instead of throwing twice and logging two errors.
- **Admin ghost** (`ws-presence-service.ts`): the `admin_user_online_upsert` is sent only while `wsConnectionRegistry.isUserOnline(userId)` still holds after the database snapshot.
- **user_online** (`ws-coordinator.ts`):
    - the connect INSERT promise is kept by socket uuid;
    - the disconnect waits for it and writes the completion only if the row was written;
    - a socket closed during the role read writes neither row.
- Docs: `websocket.md` (send results, the support fallback, sendJson after close, presence, user_online order).

## Files Modified

- `app/services/communication/broadcast-service.ts` + spec
- `app/services/support/support-service.ts` + spec (registry mock, fallback cases)
- `vendor/utils/network/ws-handlers.ts` + `ws-close-lifecycle.spec.ts`
- `app/services/communication/ws-presence-service.ts` + new spec
- `app/websocket/ws-coordinator.ts` + `ws-registry-lifecycle.spec.ts`
- `documentation/backend/websocket.md`

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `git diff --check` clean.
- `pnpm test`: backend 2385, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` with Redis: 28 files / 251 passed. `test:redis`: 11 files / 115 passed. Load average was ~30–45.
- New tests:
    - broadcast:
        - buffered (0) counts for a single target and for all three;
        - a drop (2) ends that connection with 1013 and is not counted;
    - support:
        - the asking connection still registered → tokens to it only;
        - gone → to every tab;
    - ws-handlers: a reply after the close handler ran → no send, no error log;
    - coordinator:
        - a disconnect before the connect INSERT commits completes after it;
        - a failed INSERT → no completion;
        - closed during the role read → neither row;
    - presence:
        - online → upsert;
        - offline by the time the snapshot returns → no upsert.
- Mutation check, each file from `main`:
    - broadcast: 2 cases fail;
    - support: 1;
    - ws-handlers: 1;
    - coordinator: 3;
    - presence: 1.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next and last by the plan: G5 (operations and logs).
