# feat-193: Config-Time Shared Source and One API Prefix Rule

## Current State

Implemented, waiting for review. Three findings of the review of `main` at 81e27b8 are fixed,
one commit each.

## Changes

1. **Duplicate `env.d.ts`** (`b1be91f`): `packages/frontend/env.d.ts` removed (a stale subset of
   `ImportMetaEnv`); `tsconfig.app.json` / `tsconfig.vitest.json` no longer include it.
2. **One API prefix rule** (`aa52b5a`): `shared/api-prefix` (`normalizeApiPrefix`,
   `DEFAULT_API_PREFIX`) replaces the copy in `shared/ws-client`, the backend's
   `normalizePath(...)` for `API_PATH_PREFIX` and the hand-written copy in `vite.build-meta.ts`.
   Anything that normalizes to empty (``, `/`, `//`) means `api` everywhere. Docs: configuration
   (rule), deployment (compose takes the value as is).
3. **Vite configs read shared from source** (`f2bda85`): `vite.product.ts`, `vite.backend.ts`,
   `vite.build-meta.ts`, `api-playground/vite.config.ts` import `../shared/src/<module>/index`;
   ESLint (`regex: '^shared(/|$)'`) forbids bare `shared/*` in Vite configs of both packages.
   `dev-backend` uses `key in shell` (the frontend program has no ES2022 lib for `Object.hasOwn`).
   Docs: shared/index (exception, new subpaths), guide/your-project.

## Evidence of Completion

- `make check`: passing — backend 2702, frontend 544, playground 115, shared 39, docs 26.
- `pnpm docs:build && pnpm docs:verify`: passing.
- Manual (1): `vite --port 5198`, `PRODUCT.name` edited in `shared/src/product/index.ts` without
  `build:shared` → `[vite] ../shared/src/product/index.ts changed, restarting server...`;
  `manifest.json` and `<title>` showed the new name. File restored.
- Manual (2): backend config vs `resolveDevBackend` for `API_PATH_PREFIX=/` →
  `{"serverPrefix":"api","clientPrefix":"api"}`; `//` → api/api; `/v1/` → v1/v1
  (was `{"serverPrefix":"","clientPrefix":"api"}` in the review).
- Manual (3): ESLint flags a bare `shared/product` in `frontend/vite.product.ts` and
  `shared/dev-backend` in `api-playground/vite.config.ts`; relative source imports pass.
- e2e: run by CI on the PR.

## Notes for Next Session

- After merge: "Mark feat-193 done" PR on `main` (status, evidence), deleting this file.
