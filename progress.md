# feat-143: Visible CSRF Opt-Out

## State

Done, waiting for review. Start PR: #461.

## Changes

- `packages/backend/src/config/csrf.ts`: the warning for `CSRF_ENFORCE=false` is given in every environment
  (was production-like only); new warning for `CSRF_STRICT_ORIGIN=false`. Defaults stay `true`
  (unset or blank → `true`), so protection is on unless switched off explicitly.
- Tests: `csrf.spec.ts` (default on outside production without warnings, non-false values never switch
  protection off, warnings in dev and production-like), `validate-runtime-config.spec.ts` (local start logs both).
- Docs: `guide/csrf.md`, `backend/security.md`, `packages/backend/README.md`, `.env.example`, root README
  checklist.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm --filter backend test`: 192 files, 2562 tests passed.
- `pnpm docs:build && pnpm docs:verify`: passed.
- Mutation check: restoring the production-only condition fails 2 new tests; passes after revert.
- Manual (2026-11-06): local `tsx src/index.ts` with `CSRF_ENFORCE=false CSRF_STRICT_ORIGIN=false` logs both
  WARN lines at start; with defaults there is no CSRF warning and the server listens.

## Notes for Next Session

None.
