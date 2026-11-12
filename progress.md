# Progress: feat-188 Shared Source In Dev

## Current state

Done, in review. The DX review found that the root `dev` builds `shared` once, consumers import it from `dist/`, and a schema or contract change was not visible until a manual rebuild.

- `packages/shared/package.json`: every subpath export has a first `shared-source` condition pointing at its `src/*.ts` twin. Without the condition, resolution still lands on `dist/`.
- Backend: `dev` is `tsx watch --conditions=shared-source src/index.ts`. tsx follows the import into `packages/shared/src` and restarts on a change there.
- Frontend: `vite.shared-source.ts` plugin prepends the condition only for `serve` outside mode `test`. `vite build` and Vitest stay on `dist/`.
- API Playground: the same rule inline in `vite.config.ts` (function config, `command` and `mode` are at hand).
- Unchanged: `start`, Docker, `typecheck`, tests, `vite build` and CI still read `dist/`; the root `dev` keeps its initial `build:shared` and backend build (backend typecheck and the IDE use `dist/*.d.ts`).
- Docs (uk and en): `guide/project-structure`, `guide/getting-started`, `guide/first-endpoint`, `backend/adding-a-feature`, `reference/scripts`. `AGENTS.md` line about `pnpm dev`.

## Evidence of Completion

- `packages/shared/test/exports.test.js` (new): 2 tests, RED before the export change (`shared-source` missing), green after.
- `make check`: passing (backend 2690, frontend 532, api-playground 115, shared 33, documentation 26).
- `pnpm --filter frontend test:e2e`: 92 passed (local web server is `vite dev`, so it runs on `shared/src`).
- `pnpm build`: passing. Resolved Vite conditions: frontend and playground `serve`/development include `shared-source`; `build`/production and `serve`/test do not.
- `pnpm docs:build && pnpm docs:verify`: passing.
- Manual golden path: `pnpm dev` with `services:up`. A frontend module served by Vite imports `/@fs/.../packages/shared/src/ws-client/index.ts`. Appending an export to `packages/shared/src/limits/index.ts` gave a Vite `hmr update` for the importing views and `[tsx] change in ./../shared/src/limits/index.ts Restarting...` with the backend listening again about 2 s later; the edit was reverted.

## Notes for Next Session

Nothing open.
