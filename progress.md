# feat-144: Makefile Developer Entry Point

## State

Done, waiting for review. Start PR: #465.

## Changes

- `Makefile`: 42 targets in groups (Start, Development, Quality, Tests, Services, Database, App in
  Docker, Documentation, Build and clean). Each target only delegates to a pnpm script or `scripts/*`;
  `make` with no target prints self-documented help (`## description`, `##@ Group`). `PKG=` picks a
  package for `make test`, `ARGS=` is passed to the script. GNU Make 3.81 compatible, `.NOTPARALLEL`
  keeps composite targets in order.
- `make check` = build shared → verify-makefile → format:check → typecheck → lint → test.
- `scripts/doctor.sh`: Node `^<.nvmrc>` and pnpm `>=9` required (exit 1), Docker and `.env` warn.
- `scripts/verify-makefile.mjs`: fails on a target without `## description`, a `.PHONY` mismatch, a
  `$(PNPM)` call to a missing script, or a missing `scripts/` file. Runs in `make check`.
- `init.sh`: thin wrapper over `make init` (install, build shared, check, build).
- CI `quality` job: the shared build / format / typecheck / lint / test steps are one `make check`.
- `.editorconfig`: tabs for `Makefile` only (Prettier owns everything else).
- Docs: README, AGENTS.md, new `documentation/reference/make.md` (sidebar + `KEY_PAGES`),
  `guide/getting-started.md`, `guide/workflow.md`, `reference/scripts.md`.

## Evidence of Completion

- `make check` (includes `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`): exit 0;
  backend 192 files / 2562 tests, frontend 34 / 400, api-playground 7 files, shared 25, documentation 26.
- `./init.sh`: exit 0.
- `pnpm docs:build && pnpm docs:verify`: all checks passed.
- Mutation check of `verify-makefile`: a wrong script name, a missing description, a target missing
  from `.PHONY` and a missing `scripts/` file each fail with a named error.
- Manual (2026-11-06): `make` prints the grouped help; `make -n check`, `make -n test PKG=backend
ARGS=--reporter=dot`, `make -n db-seed ARGS=--demo` expand to the expected pnpm commands; `make env`
  creates `.env` from the example only when it is missing; `make doctor` passes locally and exits 1
  with a fake pnpm 8.15.0.

## Notes for Next Session

None.
