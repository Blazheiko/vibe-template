# Session Progress Log

## Current State

**Last Updated:** 2026-11-02
**Active Feature:** feat-081 - Schema (review)
**Branch:** `chore/schema-cleanup`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase M

## Status

- [x] **Owner decision recorded: `llm_text_usage.user_id` is `ON DELETE SET NULL`.** The usage log (tokens, cost) outlives the account and the row no longer points at a person. What is left of a prompt text (only with `AI_USAGE_STORE_PROMPTS=true`) is removed by `llm:purge-prompts` by age, whoever the row belonged to (it filters by `created_at` only). The chat history (`support_chat_history`) is personal content and still goes with the user (cascade, tested)
- [x] **`support_chat_history`**: index `(user_id, created_at)` replaces `(user_id)` (the leading column serves every lookup by user alone, so the old index was redundant)
- [x] **One migration** `20261102053350_llm_usage_set_null_support_history_index` (`DROP INDEX`, `CREATE INDEX`, replace the FK); `drizzle-kit generate` run again says "No schema changes"
- [x] **`schema-feat-081.pg.test.ts`** (3 tests on a real PostgreSQL): a deleted user's usage rows stay with `user_id` NULL; their chat history is gone; the index is `(user_id, created_at)` and the old one is not there. With the migration moved aside, 2 of the 3 fail
- [x] Docs: `backend/database.md` (migration row), `backend/ai.md` (what happens to usage rows on deletion)

## Evidence of Completion

| Check                                      | Result                                                            |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `pnpm --filter backend test:pg`            | 87 passed (incl. 3 new), 64 skipped (Redis-only)                  |
| `drizzle-kit generate` after the migration | "No schema changes"                                               |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                            |
| `pnpm build`                               | exit 0                                                            |
| `pnpm test`                                | backend 1844, frontend 344, shared 24, api-playground 62, docs 26 |
| `docs:build && docs:verify`                | passed                                                            |
