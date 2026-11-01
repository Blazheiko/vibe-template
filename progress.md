# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-065 - LLM Prompt Retention (in progress)
**Branch:** `fix/llm-prompt-retention`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase F1 (owner's decision: the plan's recommended default)

## Status

### Done

- [x] Diagnosis: `llm_text_usage.final_prompt` stored the whole prompt of every model call — what the user wrote and, for the support chat, up to 20 messages of their history — for ever, and `GET /admin/usage/text` showed it to every admin. Truncating it would not have protected personal data (it can be anywhere in the text)
- [x] Decision (owner): by default keep a **SHA-256 and a length**, not the text; the text only with `AI_USAGE_STORE_PROMPTS=true`, with a 30-day retention and a purge script
- [x] Tests first (20 unit tests failed before): config (strict boolean — a typo must not start keeping prompts, retention integer ≥ 1), `recordText` (no text by default, hash + length, text with the flag, code points not UTF-16 units, same prompt → same hash), the controller (`finalPrompt: null` for a row without text, hash and length in the answer, a row from before the hash), `planPurge`, and on real PostgreSQL the purge (14 tests with the usage ones)
- [x] Migration `20261101124616_llm_usage_prompt_hash`: `prompt_sha256 varchar(64)` and `prompt_chars integer`, both nullable (a second `drizzle-kit generate` says "No schema changes")
- [x] `llm-usage-service.ts`: `final_prompt = ''` unless the flag is on; the hash and the length are always written
- [x] `GET /admin/usage/text`: `finalPrompt: string | null` (null = no text kept), `promptSha256`, `promptChars` (shared schema `TextUsageRowSchema`)
- [x] `llm:purge-prompts` (`scripts/purge-llm-prompts.ts`, `--dry-run`, `--all`, `--days=<n>`): empties `final_prompt` and first fills `prompt_sha256` / `prompt_chars` for rows that lack them, using the database's own `sha256` and `char_length` (checked equal to the application's); with the flag off it removes all text, with it on only text past the retention; idempotent; an unknown argument is an error. Run end to end on a scratch database
- [x] Docs: `backend/ai.md` ("Що журнал зберігає від промпту", PII), `backend/configuration.md`, `.env.example`, `scripts/README.md`

### Behaviour changes to know

- **New rows no longer carry the prompt text.** Anyone reading `llm_text_usage.final_prompt` (or the admin API) now gets an empty value / `null` unless `AI_USAGE_STORE_PROMPTS=true`.
- **Rows already in the table keep their text** until `llm:purge-prompts` is run once after the update (it is not run automatically, and backups keep it as long as they live). The purge is irreversible.
- Run `llm:purge-prompts` from cron to apply the retention when the text is kept.

## Evidence of Completion

| Check                                      | Result                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Tests first                                | 20 unit tests failed before the change; the purge module and the new columns did not exist     |
| `drizzle-kit generate` after the migration | "No schema changes, nothing to migrate"                                                        |
| CLI on a scratch database                  | dry run counts; `STORE=true` purges only the 40-day-old row; default purges all; hashes filled |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                                         |
| `pnpm test`                                | backend 1430, frontend 257, api-playground 29, shared 17, docs 26; exit 0                      |
| `test:pg` with Redis / without             | 148 passed / 84 passed, 64 skipped (10 new purge and column tests)                             |
| `test:redis`                               | 89 passed (not affected)                                                                       |
| `docs:build && docs:verify`                | passed                                                                                         |

## Notes for Next Session

1. Merge this PR; then a PR flipping feat-065 to `done`
2. Next: phase G (feat-069, regression coverage before refactors)
