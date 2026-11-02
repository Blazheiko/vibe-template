# feat-085 — Docs Audit Fixes

Plan: `docs/plan/docs-issues-fix-plan.md` (items 76, 77, 79 from `docs/plan/docs-issues-fix-audit.md`).

## Current state

Implemented, awaiting review. The start PR #287 (feat-085 → `in_progress` on `main`) is green and waits for a merge.

## Files modified

- `packages/backend/src/app/middlewares/admin-guard.ts` (+ spec): 403 through `forbidden()` + `appErrorToPayload` → `{ status: 'error', code: 'forbidden' }`.
- `packages/backend/src/database/pool-options.ts` (+ spec), `packages/backend/src/db/seed.ts`: `options: '-c TimeZone=UTC'`.
- `packages/shared/src/schemas/auth/login.ts`, `packages/shared/test/contracts.test.js`: optional `token?`.
- `packages/backend/src/app/services/auth/auth-service.throttle-contract.spec.ts`: removed a cast the optional `token` made unnecessary.
- Docs: `documentation/backend/{middlewares,auth,database,adding-a-feature}.md`, `docs/plan/code-issues-found-during-docs.md` (statuses 55, 74–80), audit + plan.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 1861, frontend 373, api-playground 62, shared 25 passed.
- `test:pg` on local PostgreSQL (server TimeZone `Europe/Kiev`): 88 passed, 64 skipped (Redis-dependent suites). The new UTC test of the main and session-check pools fails with the option removed.
- `pnpm docs:build && pnpm docs:verify` passed.
- Manual: through Drizzle on the local server, `defaultNow()` vs JS `Date` differ by 7 200 007 ms without the option and by 2 ms with `TimeZone=UTC`; a pool built from `connectionOptions` reports `current_setting('TimeZone') = UTC`.
- Not run: `test:e2e` (no UI change); manual `GET /api/admin/users` on a running server (covered by the admin_guard unit test).

## Review follow-up

- `SessionCheckPoolOptions.connection` now declares `options`; pg test checks `TimeZone = UTC` on both pools.
- Item 76 marked partially fixed: the login/init date DTO stays open.

## Next step

Review + merge, then a "Mark feat-085 done" PR on `main` that deletes this file.
