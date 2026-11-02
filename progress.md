# Session Progress Log

## Current State

**Last Updated:** 2026-11-02
**Active Feature:** feat-080 - Repo Hygiene (review)
**Branch:** `chore/repo-hygiene`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase L

## Status

- [x] **`progress.md` / `session-handoff.md` off `main`**: the stale ones (feat-076) are removed; `AGENTS.md` and `documentation/guide/workflow.md` now say they live on the feature branch and that the "Mark feat-XXX done" PR deletes them from `main`, the evidence staying in `feature_list.json`. `init.sh` does not reference them
- [x] **`.gitignore`** gets `.pnpm-store/`; **`.dockerignore`** gets `.claude`, `.idea`, `.omx`, `.pnpm-store` and the internal `docs/` subtrees, but **not** `docs/support-knowledge-base` (the Dockerfile copies it into the image) and **not** `documentation/` (a pnpm workspace member: `--frozen-lockfile` needs its `package.json`). The plan listed both; the first would break the image, the second the install
- [x] **`presentation.html` → `docs/presentations/overview.html`** (not `presentation.html`: the name differs from `PRESENTATION.html` only by case, which collides on macOS); its screenshot paths and `docs/screenshots/README.md` updated
- [x] **`AGENTS.md`**: `docs/` is internal, `documentation/` is the public site
- [x] **ESLint for JS**: `*.js` / `*.mjs` / `*.cjs` are no longer ignored; they get the recommended rules without type information, Node globals (`globals`, new root devDependency) and no TypeScript return-type rules. `packages/backend/public/**` (the SPA copied in by the build, gitignored) is ignored instead. What it found: a literal zero-width space and a no-break space inside a regex in `documentation/scripts/verify/lib.mjs`, now written as `​` / ` ` (same pattern; its 26 tests pass)
- [x] **CI**: every `uses:` in the four workflows is pinned to a commit SHA with the version in a comment (resolved from the current major tag); `.github/dependabot.yml` for `github-actions`, weekly

## Evidence of Completion

| Check                                      | Result                                                            |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `docker build .`                           | built (with the new `.dockerignore`)                              |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                            |
| `pnpm build`                               | exit 0                                                            |
| `pnpm test`                                | frontend 344, backend 1731, shared 24, api-playground 62, docs 26 |
| `docs:build && docs:verify`                | passed                                                            |
