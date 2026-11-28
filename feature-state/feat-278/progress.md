# feat-278 · Lazy routes, stale-chunk recovery, cold-start budget

Tasks T1–T7 of [docs/plan/frontend-tasks.md](../../docs/plan/frontend-tasks.md). Branch `feat/fe-lazy-routes`, owner Blazheiko.

## State

All tasks T1–T7 done; ready for review.

## Baseline (T1)

`./init.sh` on `cf70b43d` (main after #908): exit 0. Backend 3989 tests, frontend 1035, landing 103, api-playground 115.

## Changes

- **T2.** `packages/frontend/scripts/check-cold-start-budget.mjs` + pure part `cold-start-budget.mjs` and its spec. The script builds the app in memory (`write: false`, a plugin reads the bundle in `generateBundle`) instead of the manifest of a temp dir the plan named: same data (static imports, `importedCss`, `moduleIds`, final code), no files written, no stale `dist/`. Wired as `pnpm check:cold-start` and `make check-cold-start`, part of `make check` (so the CI `quality` job). Docs: AGENTS.md, workflow, make and scripts references (both locales).
- **T3.** Every route except `Login` is `() => import(...)` (account, support, about, verify-email, reset-password, OAuth link confirm, the whole admin area).
- **T4.** `AvatarEditorModal` through `defineAsyncComponent`; `vue-advanced-cropper` loads when the editor first opens.
- **T5.** `src/utils/preload-recovery.ts`, `ChunkLoadNotice.vue`, keys `app.chunkLoad.*` (en/uk/pl), wired in `main.ts`; the existing `router.onError` → Sentry skips chunk errors, the recovery reports only when it gives up.
    - Deviation from the plan, on purpose: the `vite:preloadError` listener calls `preventDefault()` **only when it reloads itself**. Vite's preload helper resolves a prevented import with `undefined` instead of rejecting it, so preventing it during a navigation would hand the router an empty component instead of the error `router.onError` recovers from.
    - Self-review fix: the offline retry reloads only while its notice stands, so a user who navigated elsewhere meanwhile is not taken back to the old target.
  - Found while testing: Vite fetches a lazy chunk twice (the `modulepreload` and the `import()`); a failed `modulepreload` alone is ignored, the import retries the URL.
- **T6.** `e2e-security/stale-chunk.spec.ts` (404, aborted request while online, a chunk that keeps failing, offline); `scripts/stale-build-check.sh` + `playwright.stale-build.config.ts` + `e2e-stale-build/stale-build.spec.ts` (`pnpm --filter frontend test:e2e:stale-build`): real builds A and B, backend restart on B, active SW. Decision recorded in the docs: `skipWaiting()` stays.
- **T7.** Budget lowered to 293 000 B; docs `documentation/frontend/index.md` (+ en): lazy pages and recovery, `skipWaiting()`, the budget and the stale-build check.

## Measurements (`node scripts/check-cold-start-budget.mjs`, gzip)

|                      |      en |      uk |      pl |                max |
| -------------------- | ------: | ------: | ------: | -----------------: |
| before (`cf70b43d`)  | 331 054 | 340 156 | 339 199 | 340 156 (332.2 KB) |
| after (T3 + T4 + T5) | 277 636 | 286 846 | 285 872 | 286 846 (280.1 KB) |

−53 310 B (−15.7 %) for the heaviest locale. The rest of the entry is mostly Sentry (feat-280) and pwa-install (feat-281).

## Evidence of Completion

- `make check`: exit 0. `check-bundle-graph: 766 modules, no schema and no validator library.`; `check-cold-start-budget: /login max 280.1 KB (uk), budget 286.1 KB.`; tests: backend 273 files / 3989 passed, frontend 85 files / 1049 passed, landing 6 / 103, api-playground 11 / 115.
- `pnpm --filter frontend test:e2e`: 134 passed.
- `test:e2e:security` (prod build, local PostgreSQL + Redis): `stale-chunk.spec.ts` 4 passed (3 runs in a row green), `service-worker.spec.ts` passed. `csrf.spec.ts:124` ("session lost in another tab") fails — **pre-existing**: it fails 3 of 3 on a clean worktree of `main` `cf70b43d` too (the suite is not in CI). Not touched here.
- `pnpm --filter frontend test:e2e:stale-build`: 1 passed — a tab of build A clicks About after the backend restarted on build B: one reload, B's page (marker), A's caches gone (B's SW took over), no notice, no second reload.
- `pnpm docs:build && pnpm docs:verify`: `verify-dist: all checks passed`.
- Golden path (production build served by the backend, in the e2e runs above): home → About through a lazy chunk; sign-in, account, admin pages and notifications through lazy chunks in the mock e2e suite.

## Notes for Next Session

- Local setup: the database of `packages/backend/.env` did not exist; created with `make db-create && make db-migrate`.
- Next feature for this owner: `feat-279` (header keyboard and i18n).
