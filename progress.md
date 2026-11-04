# feat-118 — LLM Usage Audit for Aborted Calls

Plan: `docs/plan/code-review-2026-11-03-plan.md`, item R12b (finding 28). Branch: `fix/feat-118-llm-usage-audit` (from `main` after #386).

## Current State

Implemented; PR open.

- Migration `20261104165815_llm_usage_status`: enum `llm_text_usage_status` (`completed` / `aborted` / `failed`) and `llm_text_usage.status` (default `completed`), plus `tokens_estimated boolean NOT NULL DEFAULT false`.
- `app/services/ai/usage/usage-audit.ts`:
    - `auditCall` writes one report with `settle(status, outputChars)`; later calls are no-ops. It keeps the last reported usage, or else estimates (characters / 2 of the prompt and of the streamed text).
    - `withUsageAudit(adapter)` wraps the stream:
        - the first `next()` is the start;
        - completion → `completed`;
        - a thrown `AbortError` → `aborted`, a timeout or any other error → `failed`;
        - a consumer that stops reading → `aborted`, and the provider stream is closed;
        - a stream never read, or an adapter without a key, writes nothing.
    - `ai-provider.ts` hands out only wrapped adapters.
- Adapters:
    - `TextStreamOptions.onUsageReported` gets usage as soon as the provider reports it: OpenAI after each round, Mistral on its usage chunk (now handled before that chunk's text is yielded);
    - the embedding adapter uses `auditCall` around the request; its estimate counts every text of a batch.
- `llmUsageService.textUsageRecorder`: one row per recorder (`recorded` flag), with `status` and `tokens_estimated`. `onUsage` (budget) gets reported usage only, `UNKNOWN_USAGE` when estimated, so the budget keeps its reserve.
- `token-estimate.ts`: `tokensOfText` and `reportedTokens` moved there from `support-budget.ts` (re-exported), plus `estimatedUsage` and `hasReportedUsage`.
- Stats: `totalTokens` (reported only), `estimatedTokens`, `callsWithoutUsage` (estimated or NULL), `abortedCalls`, `failedCalls`.
- API: the rows carry `status` and `tokensEstimated`, and the shared schemas are updated.
- ADR 0003 addendum (start boundary = `begin` followed by the first stream step; audit vs budget estimates).
- Docs: `ai.md`, `database.md`.

## Files Modified

- Schema + migration; `app/services/ai/types.ts`, `ai-provider.ts`, `adapters/openai-text-adapter.ts`, `mistralai-text-adapter.ts`, `openai-embedding-adapter.ts`
- `app/services/ai/usage/llm-usage-service.ts`; new `usage-audit.ts` and `token-estimate.ts`; `support/support-budget.ts`
- `app/repositories/ai/usage/llm-usage-repository.ts`, `controllers/http/ai/usage/llm-usage-controller.ts`, `packages/shared/src/responses/llm-usage-controller.ts`
- Tests:
    - new `usage-audit.pg.test.ts`;
    - updated `usage-recording.spec.ts`, `llm-usage-controller.spec.ts` and `llm-usage.pg.test.ts`.
- `docs/adr/0003-llm-budget-reservation.md`, `documentation/backend/ai.md`, `database.md`

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 2347, frontend 400, api-playground 62 passed.
    - In one full run, `upload-limits.transport.spec.ts` (20 parallel 50 MiB uploads) failed under load and passed alone, 7/7. It is not touched here.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` with Redis: 28 files / 244 passed. `test:redis`: 11 files / 107 passed.
- `usage-audit.pg.test.ts` (real PostgreSQL, audited adapter + real recorder):
    - success → one `completed` row, reported tokens;
    - error before the first chunk → one `failed` row, estimated;
    - usage reported then the consumer stops → `aborted`, not estimated, real 17 tokens;
    - stopped without usage → `aborted`, estimated, 4 completion tokens for 8 characters;
    - `AbortError` → `aborted`, `TimeoutError` → `failed`;
    - completion plus two late reports → exactly one row, `completed`;
    - a stream never read → no row;
    - stats split reported 17 from the estimate, with 2 calls without usage, 1 aborted and 1 failed.
- Unit (`usage-recording.spec.ts`):
    - Mistral cut off on its last chunk → one `aborted` row with the reported 7 tokens;
    - a failed Mistral request → one `failed` estimated row;
    - embeddings without usage → an estimate marked `estimated`;
    - a failed embedding → one `failed` report.
- Mutation check:
    - without the wrapper, 5 PG cases fail;
    - without the recorder's one-row flag, the late-report case fails.
- Manual:
    - `db:migrate` on a throwaway database gives `status llm_text_usage_status default 'completed' NOT NULL` and `tokens_estimated bool default false NOT NULL`; a new row is `completed|f`;
    - the built backend on it answers `/api/ready` 200 and `/api/admin/usage/stats` without a session 401, and SIGTERM exits 0.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR. R12b is the last item of the plan.
