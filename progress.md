# Progress: feat-187 Transport Import With Extension

## Current state

Done, in review. The review of `main` 724448e found that ESLint missed the transport when it was imported with an extension.

- `packages/frontend/eslint.config.ts` now has one regex for the transport module: `(^|[/])base-api([.][cm]?[jt]sx?)?([?].*)?$`. It matches `./base-api`, `./base-api.ts`, `@/utils/base-api.js`, `.mjs` and a Vite `?query`, but not `my-base-api` or `base-api-docs`.
- Both the `no-restricted-imports` pattern (`regex` instead of `group`) and the `ImportExpression` selector use it.
- Docs: `backend/routing.md` (uk and en).

## Evidence of Completion

- `api-bypass-lint.spec.ts`: 15 passed. The 5 new cases (`.ts`, `.js` and `.mjs` imports; `import()` with `.ts` and with `.js`) failed before the fix. A negative case covers similarly named modules.
- `make check`: passing (frontend 532, backend 2690, api-playground 115, shared 31, documentation 26).
- `pnpm lint`, `pnpm docs:build && pnpm docs:verify`: passing.
- e2e is not needed: only the lint config and a test changed, with no runtime code.

## Notes for Next Session

Nothing open.
