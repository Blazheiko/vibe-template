# feat-216: Backend Feature Skill In The Repository

## Current State

Done, ready for review.

## What Changed

- `.gitignore`: `.claude/` → `.claude/*` + `!.claude/skills/`. Shared agent skills are versioned;
  `settings.local.json`, `worktrees/` and the lock file stay ignored.
- `.claude/skills/backend-feature/SKILL.md` (moved from the owner's `~/.claude/skills`): brought up
  to date with the code. `ServiceResult`/`failure()` → `AppResult` + `errors.ts` helpers; local
  status maps → `requireUserId`, `parseEntityId`, `respond`, `ParamsOf`; transformer ids as
  strings and `toISOString()` (no luxon); `@arktype/type` with bounds and `'+': 'reject'`;
  responses as `type.or(..., CanonicalErrorResponseSchema)`; repositories/services in domain
  subfolders with `I…Repository` + `executor`; registry passed to `mergeContractSchemas`;
  `withCurrentSession` (feat-098); WS user from `context.userData`; `db:generate --name`; service
  spec, Definition of Done and docs steps. `documentation/en/backend/adding-a-feature.md` is named
  its source of truth.
- `.claude/skills/backend-feature/evals/evals.json`: expectations match the current patterns.
- `AGENTS.md`: new "Agent Skills" section (where shared skills live, a pattern change updates the
  tutorial and the skill in the same PR).

## Files Modified

- `.gitignore`, `AGENTS.md`, `progress.md`
- `.claude/skills/backend-feature/SKILL.md`, `.claude/skills/backend-feature/evals/evals.json`

## Evidence of Completion

- Every module, helper and identifier the skill names checked against the code (`errors.ts`,
  `controller-error.ts`, `require-user-id.ts`, `parse-id.ts`, `session-guard.ts`,
  `contract-registry.ts`, `contract-schemas/index.ts`, `types.d.ts`, `api-client.ts`,
  `ws-client.ts`, `kernel.ts`).
- `git check-ignore`: `.claude/settings.local.json` and `.claude/worktrees/` still ignored.
- `make check`: passed (backend 2983, frontend 607), including `format:check` over the skill files.
- Not verified: an end-to-end run of the skill generating a feature (no runtime code changed).

## Notes for Next Session

Mark feat-216 done on `main` and delete this file.
