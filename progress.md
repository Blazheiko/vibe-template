# feat-105 — Prompt Context Replace

Plan: `docs/plan/code-review-2026-11-03-plan.md`, item R11a. Branch: `fix/feat-105-prompt-context-replace` (from `main` at `774b1fb`).

## Current State

Implemented; PR open.

- `support-llm-service.ts` `chatStream`: `systemPromptTemplate.replace('{context}', () => knowledgeContext)`. The missing-placeholder fallback is now detected with `includes('{context}')`, not by comparing the result with the template; that comparison was also wrong when the context itself was `{context}`.
- Docs: `documentation/backend/ai.md`.

## Files Modified

- `packages/backend/src/app/services/support/support-llm-service.ts`
- `packages/backend/src/app/services/support/support-llm-service.spec.ts` (new)
- `documentation/backend/ai.md`

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 2232, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `support-llm-service.spec.ts`, 7 cases:
    - context with `$&`, `$'`, `` $` ``, `$$`, `$1 $<name>` is put in verbatim;
    - no placeholder → appended, with a warning;
    - a context equal to `{context}` is not mistaken for a missing placeholder.
- Mutation check: on `main`'s service, 5 of the 7 cases fail. The `$1 $<name>` case passes there too, because a string pattern has no capture groups.
- Manual: not applicable beyond the spec. The prompt is built in memory; there is no LLM call in tests.
- No PG / Redis code touched.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next by the plan order: R06a (phone reset transaction).
