# feat-119 — Code Review Follow-up (F1–F5)

Plan: `docs/plan/code-review-2026-11-03-plan.md`, section «Повторне рев'ю 2026-11-04» (review of db24659..2e0450a, verdict REQUEST CHANGES; start #390). Branch: `fix/feat-119-review-follow-up`.

## Current State

Implemented; PR open. I confirmed all five findings in the code before fixing them.

- **F1 (high), session lifetime on WebSocket.**
    - `isPastMaxAge` moved to `vendor/utils/session/session-age.ts`.
    - `getSession` (HTTP requests and every WS message) refuses and deletes a record past `SESSION_MAX_AGE_DAYS`; the delete is best-effort.
    - The WS upgrade applies the same check to the record it reads.
    - The duplicate check in `RequestSession.restore` is removed, because the store now does it.
- **F2 (high), OAuth callback after logout.**
    - `callback` consumes `oauthState` / `oauthCodeVerifier` (CAS `updateSessionData`) before `handleCallback`.
    - `null` (session deleted after it was read) → error redirect `session_revoked`, no sign-in.
    - A consumption failure → error redirect, no sign-in.
    - The cleanup after the sign-in is gone.
- **F3 (medium), KB import vector after a lost lease.**
    - `indexArticle(article, { signal })` passes the signal to the embedding request and calls `signal.throwIfAborted()` right before `storeVector`.
    - The init service passes `lock.lost`, and a provider-wrapped abort is recognized through the signal.
- **F4 (medium), embedding audit.**
    - Reading the response is inside the audited call.
    - An empty `embed` response, or a batch with fewer vectors than texts, is one `failed` row with the reported usage.
- **F5 (medium), `reindexAll` count.** It counts the vectors `storeVector` wrote, not the rows read.
- Docs: `auth.md` (one age check for HTTP and WS), `oauth.md` (state consumed first, the remaining window), `ai.md` (lease signal before the write, the `reindex-all` count, embedding audit).

## Files Modified

- New: `packages/backend/src/vendor/utils/session/session-age.ts`.
- Changed:
    - `redis-session-storage.ts`, `request-session.ts`;
    - `app/websocket/ws-session-auth.ts`, `app/controllers/http/auth/oauth-controller.ts`;
    - `app/services/support/support-embedding-service.ts`, `knowledge-base-init-service.ts`;
    - `app/services/ai/adapters/openai-embedding-adapter.ts`.
- Tests:
    - `ws-session-auth.spec.ts`, `oauth-controller.spec.ts`, `support-embedding-service.spec.ts`, `usage-recording.spec.ts`;
    - `session-store.redis.test.ts`, `knowledge-base-init.redis.test.ts`, `kb-embedding-consistency.pg.test.ts`.
- Docs as above.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 2353, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` with Redis: 28 files / 244 passed. `test:redis`: 11 files / 111 passed.
- **F1:**
    - real Redis: a WS message of a 31-day session → `missing` and the record deleted; 29 days → ok;
    - spec: an upgrade of a 31-day session → `missing`, record deleted, no token lookup.
- **F2:**
    - real Redis, with a barrier (state read via `session_web`, then logout): `handleCallback` is not called, 302 `session_revoked`, no session record left for the user;
    - with the session intact, the state is already consumed when the sign-in runs;
    - specs: consumption precedes `handleCallback`, `null` → no sign-in, a Redis failure → no sign-in and a redirect.
- **F3:**
    - spec: the signal aborted during the provider wait → rejects and writes nothing;
    - Redis: the lost lease's signal reached the indexing in flight and is aborted.
- **F4:** an empty `embed` response, and a batch with fewer vectors than texts → one `failed` report with the reported usage.
- **F5:**
    - PG: `reindexAll` racing an update returns 0;
    - spec: 3 rows with 2 stored → 2.
- Mutation check, each fix reverted to `main` on its own:
    - F1: 5 cases fail (WS message, upgrade, and the HTTP age cases, since the check now lives in the store);
    - F2: 5 fail;
    - F3+F5: 5 fail;
    - F4: 2 fail.
- Manual: the built backend starts, `/api/ready` 200, an OAuth callback without a stored state → 302 to `/?error=oauth_failed`, SIGTERM exit 0.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
