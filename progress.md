# feat-136 — AI Usage and Purge Lows (sixth review I3)

## State

Done on branch `fix/feat-136-ai-usage-purge`. Waiting for CI on the feature PR.

## Changes

- **L6** `mistralai-text-adapter.ts`, `openai-text-adapter.ts`: a usage object without
  `promptTokens` / `completionTokens` numbers is no usage (it used to be 0 real tokens and settled
  the budget at 0). The same defect was in the OpenAI `parseUsage` and is fixed there too.
- **L7** `types.ts` (`UsageReportDetails`), `openai-text-adapter.ts`, `usage-audit.ts`: the first
  round of a tool call is reported as `partial`; without the second round's usage the call's usage
  is unknown. The audit records partial usage as `tokens_estimated = true` with an estimate never
  below the reported part; the budget is not settled on a part (keeps its reservation).
- **L8** `purge-llm-prompts-args.ts`, `purge-llm-prompts.ts`: `--days` with `--all`, or with
  `AI_USAGE_STORE_PROMPTS=false` (all text would go), is an error instead of being ignored; a
  database or AI configuration error stops the script before any query.
- Docs: `ai.md`.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean
- `pnpm test`: backend 2517, frontend 400, api-playground 62; docs build + verify; local test:pg 173
- Mutation: main versions of the two adapters, `usage-audit.ts` and `purge-llm-prompts-args.ts`
  → 7 new cases fail (Mistral and OpenAI `usage: {}`, tool round partial, audit partial, --days
  twice, config error).
