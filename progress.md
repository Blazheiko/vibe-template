# feat-114 — KB Embedding Consistency

Plan: `docs/plan/code-review-2026-11-03-plan.md`, item R11b (finding 22). Branch: `fix/feat-114-kb-embedding-consistency` (from `main` after #374).

## Current State

Implemented; PR open.

- Schema + migration `20261104143331_kb_content_version`: `support_knowledge_base.content_version integer NOT NULL DEFAULT 1`.
- `supportKnowledgeRepository.update`:
    - when `title` or `content` is given, the same UPDATE sets `content_version = content_version + 1` and `embedding = NULL`;
    - `category` / `isActive` and the screenshot methods leave the version alone.
- `setEmbedding(id, vector, contentVersion)` writes only `WHERE content_version = version` and returns whether it stored.
- `supportEmbeddingService.indexArticle({ id, title, content, contentVersion })` returns `boolean`. A dropped stale vector is logged at `info`. `reindexAll` passes each row's version as it read it.
- Callers pass the row they read: `create`, `update`, `reindexArticle` (now answers `indexed: 0` when the text changed meanwhile) and KB init.
- `update` reports `embeddingIndexed` from the updated row, so a text change answers `false`.
- Docs: `ai.md` (section «Версія тексту»), `database.md`, `repositories.md`.

## Files Modified

- `packages/backend/src/database/schema.ts`, new migration folder
- `packages/backend/src/app/repositories/support/support-knowledge-repository.ts` + `support-knowledge.pg.test.ts` (version argument)
- `packages/backend/src/app/services/support/support-embedding-service.ts`, `knowledge-base-service.ts`, `knowledge-base-init-service.ts` + specs
- New: `packages/backend/src/app/services/support/kb-embedding-consistency.pg.test.ts`
- Docs as above.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 2335, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` with Redis: 26 files / 228 passed. `test:redis`: 10 files / 102 passed.
- `kb-embedding-consistency.pg.test.ts` (real PostgreSQL; the test holds each embedding call open):
    - with a fixed clock, two updates leave the same `updated_at` and version 3; the newer indexing finishes first, the older one last → `[false, true]`, and the stored vector is the newer one;
    - a screenshot change during `reindexArticle` → stored, version still 1;
    - `reindexAll` reads version 1, an update moves to 2, the batch finishes → nothing stored; the update's indexing then stores its vector;
    - a failed re-index → embedding `NULL` from the update on, `embeddingIndexed` false;
    - a category / isActive change keeps the version and the vector and starts no indexing.
- Mutation check:
    - without the version condition in `setEmbedding`, the same-clock and `reindexAll` cases fail;
    - without `embedding = NULL` in `update`, the failed re-index case fails.
- Manual:
    - the migration applied with `db:migrate` to a throwaway database gives `content_version integer default 1 NOT NULL`, and a new row gets 1;
    - the built backend on that database starts, `/api/ready` returns 200, and SIGTERM exits 0.
    - The local dev database could not be migrated: its migration journal is out of sync (`CREATE TYPE "chat_role"` from init fails). This predates the branch, and the dev database was left as it was.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next by the plan order: R11c (KB init single run, Redis lock), then R11d (storage replacement order, needs this).
