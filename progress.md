# Progress: feat-185 Review 2026-11-12 Fixes

## Current state

Done, in review. The review of cbcc6a1..c05e3ae asked for changes in three MEDIUM findings. All three are fixed, one commit each.

1. **The early WS refusal echoes the request `id`** (`d6c356b`).
    - `refuseOverBudget` in `vendor/utils/network/ws-handlers.ts` takes `event` and `id` from `requestIdentity`, which accepts only an `id` the envelope allows (1–64 characters).
    - This covers both early refusals: the message budget and the concurrent handlers.
2. **The support answer is reserved only when its chat provider is configured** (`4d1fcf4`).
    - New `supportLlmService.isConfigured(stage)` asks the adapter of the model that the stage's prompt names.
    - `runChat` (`SUPPORT_SYSTEM`) and `runOpenChat` (`SUPPORT_FIRST_CHAT`) check it before `budget.begin(chat)`, as the translation and the search already did (V14.4).
3. **Compose runs the app with the prefix of the build** (`b8002aa`).
    - In `docker-compose.yml`, `x-app-environment` now has `API_PATH_PREFIX: ${API_PATH_PREFIX:-api}`: the shell, then the `--env-file` of `pnpm app:up`, then `api`. This is the same order as `docker-build.sh`.
    - The `app` healthcheck asks for `/<prefix>/ready`.
    - `scripts/verify-compose.mjs` (`make verify-compose`, part of `make check`) runs `docker compose config` on a copy of the file for three cases: the shell, the file, and neither.

- Docs in both locales: `reference/make.md`, `backend/deployment.md`, `guide/getting-started.md` (the compose table) and `backend/ai.md` (reconciliation). Also AGENTS.md (what `make check` runs) and the comment in `docker-build.sh`.

## Evidence of Completion

- `make check`: passing. verify-compose 3 cases; backend 2686, frontend 515, api-playground 115, shared 31, documentation 26.
- `pnpm --filter backend test:pg`: 297 passed. `test:redis`: 116 passed.
- `pnpm docs:build && pnpm docs:verify`: passing.
- RED before the fixes:
    - `ws-message-budget.spec.ts`: 2 new tests (the `id` over the budget; the `id` over the handlers, and no `id` for one that is too long or not text);
    - `support-service.spec.ts` (2) and `support-llm-service.spec.ts` (2);
    - `support-chat-admission.pg.test.ts` (2): on real Redis the reserve of the answer and of the greeting is given back. Both failed against the old service;
    - `verify-compose` fails on the old compose file: the shell `v1` gives `api`, and there is no healthcheck.
- Manual check: the generated healthcheck command, run against a stub server, is healthy on `/v1/ready` and not on `/api`.
- Not checked: a full `pnpm app:up` with `API_PATH_PREFIX=v1`. The compose stack would take ports used by other local services (Redis 6379).

## Notes for Next Session

Nothing open.
