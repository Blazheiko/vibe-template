# Repository Guidelines

## Agent Startup Workflow

1. Read `feature_list.json` and find the feature whose `owner` matches you (or the human you assist) and whose `status` is `in_progress`. That is your active feature.
2. Switch to the feature's `branch`. `progress.md` and `session-handoff.md` for that feature live **on that branch**, not in `main`.
3. Read `progress.md` (on the feature branch) for last session's state, blockers, and "Notes for Next Session". If resuming, also read `session-handoff.md`.
4. Run `./init.sh` to install deps and run typecheck/lint/test before making changes. Do not proceed if it fails.
5. One feature at a time **per owner**. Stay within the active feature's scope; new work requires a new entry in `feature_list.json` via PR to `main`, not in-flight expansion.

## Team Coordination

The harness supports multiple parallel workers (humans and/or agents) under these rules:

- **`feature_list.json` lives only on `main`.** It is the single source of truth for who is working on what. Changes go through a PR; no direct edits on feature branches.
- **Each feature has exactly one `owner` and one `branch`.** Two people cannot share an `in_progress` row. If you want to help on someone else's feature, you contribute via PR to their branch, not by editing their `progress.md`.
- **`progress.md` and `session-handoff.md` live on the feature branch.** They are per-feature working files, not global state. Merge-conflicts on these files mean two owners — fix the ownership, not the conflict.
- **Status transitions are visible.** Flip `not-started` → `in_progress` → `review` → `done` via PRs that update `feature_list.json` on `main`. `blocked` is allowed; record the blocker in `progress.md` on the branch.
- **Definition of Done still applies per feature** (typecheck/lint/test + manual verification + evidence). Reviewers check the feature branch's `progress.md` for the evidence block before approving the merge.
- **Dependencies are enforced.** Do not start a feature whose `dependencies` are not yet `done`. If you need to start early, split the dependency into a smaller `feat-XXX` and complete that first.

## Definition of Done

A feature is `done` only when all of the following are recorded in `progress.md` under **Evidence of Completion**:

- `pnpm typecheck` clean
- `pnpm lint` clean
- `pnpm test` passing (and `pnpm --filter frontend test:e2e` if UI-affecting)
- Manual verification of the golden path documented
- Feature entry in `feature_list.json` flipped to `done` with the evidence commit/output referenced

## Documentation

The VitePress site in `documentation/` is published to GitHub Pages (https://blazheiko.github.io/vibe-template/) from `main` by `.github/workflows/docs.yml`.

- A change to public backend behaviour (a route, an env variable, a middleware, a migration or the DB schema) must update the matching page in `documentation/backend/` in the same PR.
- Write pages from the code and link sources on GitHub. Mark unimplemented things with `::: warning План`. Use placeholders for secrets.
- Add every new page to the sidebar in `documentation/.vitepress/config.ts` and to `KEY_PAGES` in `documentation/scripts/verify-dist.mjs`.
- When a page uses `<!--@include-->`, the source path must be covered by `paths` in `docs.yml`.
- Before merging, run `pnpm docs:build && pnpm docs:verify`.

## End of Session

Before ending, commit + push the feature branch with an updated `progress.md` (current state, files modified, next step) and, if work is unfinished, fill `session-handoff.md` so the next session can restart cleanly.

## Project Structure & Module Organization

This is a pnpm workspace with packages under `packages/*`.

- `packages/frontend`: Vue 3 + Vite app. Source lives in `src/`, static assets in `public/`, unit tests near code in `src/**/__tests__`, and Playwright tests in `e2e/`.
- `packages/backend`: TypeScript uWebSockets.js API/WebSocket server. Source is in `src/`, with app logic in `src/app`, configuration in `src/config`, the Drizzle schema and relations in `src/database`, database create/seed scripts in `src/db`, migrations in `src/drizzle/migrations`, and scripts in `src/scripts`.
- `packages/shared`: workspace package for shared schemas, enums, guards, responses, utilities, and tests in `test/`.

Generated output such as `dist/`, `node_modules/`, Playwright reports, and coverage should not be edited by hand.

## Build, Test, and Development Commands

- `pnpm install`: install workspace dependencies. Requires Node `^24.22.2` (Node 24 LTS; see `.nvmrc`) and pnpm `>=9`.
- `pnpm dev`: build `shared`, build `backend`, then run backend and frontend dev servers in parallel.
- `pnpm dev:frontend` / `pnpm dev:backend`: run one package locally.
- `pnpm build`: build all packages recursively.
- `pnpm typecheck`: run TypeScript checks across packages.
- `pnpm lint`: lint the full repository with ESLint.
- `pnpm format:check` / `pnpm format`: check or write Prettier formatting.
- `pnpm test`: run all package test suites.
- `pnpm --filter frontend test:e2e`: run frontend Playwright tests.

## Toolchain Notes

- TypeScript is pinned to `6.0.3` at the workspace root and frontend package. Keep package-level TypeScript pins aligned unless a package has an explicit compatibility reason to diverge.
- The workspace uses `pnpm.overrides` to keep `@typescript-eslint/*` packages on a TypeScript 6-compatible line. Update those overrides together with `typescript-eslint`.
- Backend `tsconfig.json` path aliases use explicit relative targets such as `./src/app/*`; do not reintroduce `baseUrl`, which is deprecated in TypeScript 6 and scheduled to stop working in TypeScript 7.
- `drizzle-orm` and `drizzle-kit` are pinned to the release candidate `1.0.0-rc.5` (no stable 1.0 yet). Upgrade both together to the same exact version, and move to `1.0.0` once it is released. Relations use Relational Queries v2 (`defineRelations` in `packages/backend/src/database/relations.ts`); migrations use the 1.0 folder-per-migration format.

## Coding Style & Naming Conventions

Use TypeScript ES modules. Follow existing package style: 4-space indentation, single quotes, no semicolons, and a 100-character print width where Prettier is configured. Prefer explicit types in shared/backend public boundaries, `type` imports, and small focused modules. Vue components use PascalCase filenames; composables use `useName.ts`; tests use `*.spec.ts` or `*.test.js`.

## Testing Guidelines

Backend and frontend unit tests use Vitest. Shared package tests use Node's built-in test runner after building. Add tests next to the behavior being changed, using deterministic fixtures and avoiding external network calls. Run the narrow package test first, then `pnpm test` when changes affect shared contracts.

## Commit & Pull Request Guidelines

Use concise, intent-first commit messages and include useful trailers when relevant, for example `Tested: pnpm test` or `Not-tested: requires production credentials`. Pull requests should describe the change, list verification performed, link related issues, and include screenshots or screen recordings for visible frontend changes.

## Security & Configuration Tips

Do not commit secrets. Use `packages/backend/.env.example` as the configuration reference. Treat auth, proxy, CSRF, Sentry, storage, mail, AI, Redis, and database settings as environment-specific.
