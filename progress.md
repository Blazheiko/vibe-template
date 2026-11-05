# feat-125 — Operations Gaps (G5a)

Plan: `docs/plan/code-review-2026-11-03-plan.md`, «Четверте рев'ю 2026-11-04», G5a (G5 split into G5a and G5b); start #408. Branch: `fix/feat-125-operations-gaps`.

## Current State

Implemented; PR open.

- **L10:** `llmUsageRepository.purgePromptText` updates in batches (`PURGE_BATCH_SIZE` = 1000, optional `batchSize`): `UPDATE … WHERE id IN (SELECT id … LIMIT n)` until a batch comes back short.
- **KB init:**
    - all files are read first, then `supportKnowledgeRepository.createMany` inserts every article in one statement, then they are indexed;
    - a lease lost before the insert leaves nothing; after it, the base is complete and the status names `reindex-all` for the missing vectors;
    - `createdArticles` is the inserted count.
- **Push endpoint:** `canonicalPushEndpoint` (lowercase host without the trailing dot, no default port, path and query unchanged) is what `upsertSubscription` checks, looks up and stores.
- **R11d:** when the swap throws, the KB screenshot and avatar services read the row first. The new object is deleted only if the row surely does not point at it; if it does, or the read fails, the object stays and a warn is logged.
- **`fetchJson`:** `AbortSignal.timeout(OAUTH_PROVIDER_TIMEOUT_MS = 10 s)`.
- Docs: `ai.md` (purge batches, init all-or-nothing), `web-push-notification.md` (canonical endpoint), `storage.md` (ambiguous COMMIT), `oauth.md` (provider timeout).

## Files Modified

- `app/repositories/ai/usage/llm-usage-repository.ts` + `llm-prompt-retention.pg.test.ts`
- `app/repositories/support/support-knowledge-repository.ts` (`createMany`), `app/services/support/knowledge-base-init-service.ts` + `knowledge-base-init.redis.test.ts`
- `app/services/notifications/push-endpoint-policy.ts` + spec, `push-subscription-service.ts`, `push-subscription-ownership.pg.test.ts`
- `app/services/support/knowledge-base-service.ts`, `app/services/user/avatar-service.ts`, `storage-object-replacement.pg.test.ts`
- `app/services/auth/oauth-service.ts` + spec
- Docs as above.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `git diff --check` clean (typecheck run last).
- `pnpm test`: backend 2390, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` with Redis: 28 files / 255 passed. `test:redis`: 11 files / 116 passed.
- New tests:
    - purge with batch 3 over 7 rows → every row emptied, at least 3 UPDATE statements;
    - KB init (real Redis, the index mock now honours the signal):
        - lease lost during indexing → 3 articles, 0 indexed, status names `reindex-all`, a later init → `NOT_EMPTY`, no duplicates;
        - lease lost before the insert → nothing created, and a later init imports 3;
    - push:
        - canonical forms;
        - PG: the owner endpoint in capitals with a trailing dot from another user → 409, nothing stored;
    - R11d (PG): a swap that committed and then threw keeps the new object for both the screenshot and the avatar;
    - fetchJson: the profile request gets an `AbortSignal`, and a timed-out provider fails the sign-in.
- Mutation check:
    - purge in one statement: 1 case fails;
    - `main`'s oauth-service: 1;
    - `main`'s push service: 1;
    - `main`'s KB and avatar services: 2;
    - `main`'s init service: 6.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next and last: G5b (scrubber bypasses of R01, tests that would pass without their fix).
