# feat-192: Local Backend Address From One Place

## Current State

Implemented, waiting for review. The Vite proxies (frontend, api-playground) and the API prefix
compiled into the bundles follow the backend's `PORT`, `HOST` and `API_PATH_PREFIX`: shell first,
then `packages/backend/.env`, then `3000` / `api` (the dotenv order the backend uses).

## Changes

- `packages/shared/src/dev-backend/index.ts` (new subpath `shared/dev-backend`): pure
  `resolveDevBackend(shell, file)` and `assertSameApiPrefix(value, prefix)`.
- `packages/frontend/vite.backend.ts` (new): reads `packages/backend/.env`; `pinApiPrefix` writes
  `VITE_API_PATH_PREFIX` into `process.env` and fails on a different hand-set value (frontend
  `.env*` or shell). Used by `vite.config.ts` (proxy key + target) and `vite.sw.config.ts`.
- `packages/api-playground/vite.config.ts`: the same rule; `.env.example` leaves
  `VITE_API_BASE_URL` empty (same origin through the proxy) and drops `VITE_API_PATH_PREFIX`.
- `packages/frontend/.env.example`: `VITE_API_PATH_PREFIX` removed.
- Backend `config/app.ts`: an empty `API_PATH_PREFIX` means `api` (was the root), like the frontend.
- `Dockerfile` / `scripts/docker-build.sh`: build-arg `API_PATH_PREFIX` instead of
  `VITE_API_PATH_PREFIX`; static-server mismatch message updated.
- Docs (uk + en): new section "Одне джерело адреси й префікса API" / "One source for the API
  address and prefix" in `backend/configuration.md`; deployment, websocket, routing,
  frontend/index, playground/index, guide/getting-started updated. READMEs of frontend and
  playground updated.

## Evidence of Completion

- `make check` (format:check, typecheck, lint, test): passing — backend 2697, frontend 544,
  playground 115, shared 39, documentation 26.
- New tests: `packages/shared/test/dev-backend.test.js` (6), `packages/frontend/src/__tests__/vite-backend.spec.ts` (5),
  `packages/backend/src/config/app.spec.ts` API_PATH_PREFIX block (4).
- `pnpm docs:build && pnpm docs:verify`: passing.
- Manual: fake backend on 127.0.0.1:4100; `PORT=4100 API_PATH_PREFIX=v1 vite --port 5199`:
  `GET /v1/ping` through the dev server reached the fake backend (`fake-backend /v1/ping`), the
  served module had `VITE_API_PATH_PREFIX: "v1"`. `API_PATH_PREFIX=v1 vite build` →
  `build-meta.json` `{"apiPathPrefix":"v1"}`; the service worker build contains `"v1"`.
  `VITE_API_PATH_PREFIX=api` with `API_PATH_PREFIX=v1` → build fails with
  `VITE_API_PATH_PREFIX=api differs from the backend API_PATH_PREFIX (v1)`.
- e2e: run by CI on the PR (UI code unchanged; config only).

## Notes for Next Session

- After merge: "Mark feat-192 done" PR on `main` (status, evidence), deleting this file.
- Docker image build with `API_PATH_PREFIX=v1` is covered by CI's `verify-compose`; a full
  `pnpm app:build` was not run locally.
