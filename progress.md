# feat-115 — KB Init Single Run

Plan: `docs/plan/code-review-2026-11-03-plan.md`, item R11c (finding 23). Branch: `fix/feat-115-kb-init-single-run` (from `main` after #377).

## Current State

Implemented; PR open.

- New `app/services/shared/redis-lease.ts`: `acquireLease(key, lease, lostError)` is the owner-token lease of the support in-flight lock (SET NX PX, Lua renew/release conditional on the token, `lost` aborts before the key can expire), moved out unchanged. `support-inflight-lock.ts` is now a thin wrapper with the same API.
- `knowledge-base-init-service.ts`:
    - `createKnowledgeBaseInitService(options)` returns one instance per process; tests create two to stand for two instances;
    - `start()` sets `running` before the first await and puts the previous state back on every early exit (not configured, lock held elsewhere, not empty, Redis error);
    - lease `support:kb-init`: TTL 30 s, renewed every 10 s, at most 1 h; the not-empty check runs under the lock;
    - the import checks the lease before each `create` and each `indexArticle`; a lost lease ends with `failed`, `Knowledge base initialization stopped: lock lost: ...`, and the unwritten file is not counted as processed;
    - release in `finally`; after a lost lease it is a no-op.
- The controller drops the `??` fallbacks: `message` is always set on refusal now.
- Docs: `ai.md` (KB init, lease module link).

## Files Modified

- New: `packages/backend/src/app/services/shared/redis-lease.ts`, `src/app/services/support/knowledge-base-init.redis.test.ts`, `src/app/services/support/knowledge-base-init-service.spec.ts`
- `packages/backend/src/app/services/support/support-inflight-lock.ts`, `knowledge-base-init-service.ts`
- `packages/backend/src/app/controllers/http/admin/admin-knowledge-base-controller.ts`
- `documentation/backend/ai.md`

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 2338, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` with Redis: 26 files / 228 passed. `test:redis`: 11 files / 107 passed. The support lock's own Redis and unit tests pass unchanged on the shared module.
- `knowledge-base-init.redis.test.ts` (real Redis):
    - two `start()` in one process → one ok, one `ALREADY_RUNNING`, 3 articles, key released;
    - two instances → one gets the lock, the refused one stays `idle`, 3 articles;
    - `NOT_EMPTY` → state back to `idle`, no key left, and a later start works;
    - lost lease (key gone, another instance took it) → the late holder's renewal leaves the new holder's TTL alone (> 30 s), its import stops with `failed: ... lock lost`, with 1 article written before and none after, while the other imports all 3;
    - a late release leaves the other holder's key.
- `knowledge-base-init-service.spec.ts`:
    - a second call while the first waits for the lock is refused, with one acquire;
    - when Redis rejects or embeddings are not configured, the state goes back to `idle`.
- Mutation check:
    - `main`'s service (no lock, `running` set late) fails all 5 Redis cases;
    - without the lease check before writes, the lost-lease case fails.
- Manual: the built backend starts with the lease in the bundle, `POST /api/admin/knowledge-base/init` without a session answers 401, and SIGTERM exits 0.
    - A full `/init` run was not done by hand: it needs an admin session, an OpenAI key and an empty KB. The real-Redis two-instance tests cover it.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next by the plan order: R11d (storage replacement order for screenshot and avatar; depends on R11b, done).
