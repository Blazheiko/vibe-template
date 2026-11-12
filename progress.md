# feat-190 — Docs Match The Code

Branch: `docs/match-code`. Owner: Blazheiko.

## Current state

Done, awaiting merge. A docs audit (four parallel passes over `documentation/` and the package READMEs) found ~75 places where the docs contradicted the code; every verified one is fixed, in the uk and en locales together. No code behaviour changes; the only non-doc edit is the `REDIS_PREFIX` comment in `packages/backend/.env.example` (16 → 1-32 chars, as `config/redis.ts`).

## What changed

- Fixed issues still described as open: frontend HTTP prefix (`websocket.md` tip), CSP in `static-server.ts` and `SERVE_STATIC` in the Dockerfile (`caching-etag.md`), tokens in logs (`observability.md`), app CI workflows (`deployment.md`), prompt cache refresh (`database.md`), format:check glob (`toolchain.md`), AGENTS.md `.git` warning (`workflow.md`).
- Broken links: `result-helpers.ts` (`request-lifecycle.md`), `user-storage.ts` (`websocket.md`), `normalize-user-id.ts` (`glossary.md`).
- Stale examples: `websocketApi` from a component → `callWs` + contracts (composables README); `defineRoute` with `url`/`validator`/`ResponseSchema` and `appErrorToWsError` → contracts, registry, `appErrorToPayload` (backend README); `enforceThrottle` options (`security.md`); OAuth `emailVerified` → `emailTrust`, `withinProviderDeadline` (`oauth.md`); `contractSchemaRegistry` spread → `mergeContractSchemas` (`first-endpoint.md`, `adding-a-feature.md`); login `token` field (`getting-started.md`); `RegisterEmailInputSchema` (`validation.md`); support snippet `admitChat`/`runChat` (`index.md`).
- Wrong facts and lists: WS reply matching by `id`, upgrade limit 120/60, per-route `maxBodySize`, guest session/CSRF token in the signed cookie, logout needs `auth_guard`, throttle policy table, config readers (`reader.int`), repositories (transactions, methods, four token repos, pg tests), testing (mocks, counts, workflows), migrations table, Compose `s3`/`mailpit`, push transport, `HttpContext`/`WsContext`, error constructors, shipped locales (en/uk/pl), GitLab provider and OAuth buttons from `/auth/oauth/providers`, shared exports/`shared-source`, scripts and Make targets, Vite proxy key, frontend CSRF retry, frontend README layout and env vars.

## Evidence of Completion

- `make check` passing (format:check, typecheck, lint, test).
- `pnpm docs:build && pnpm docs:verify` → `verify-dist: all checks passed`.
- Every GitHub `blob`/`tree` link added in the diff points to an existing path; every changed uk page has its en twin changed (except `auth.md`, where only the uk text was wrong).
- Manual: each fix checked against the cited source (e.g. `emailTrust` in `oauth-service.ts`, `rateLimited` in `services/shared/errors.ts`, support throttles in `throttle-policies.ts`, `mergeContractSchemas` in `contract-schemas/index.ts`).
- e2e not run: docs-only change, no UI affected.

## Notes for Next Session

Mark feat-190 done on `main` after the PR merges (delete this file).
