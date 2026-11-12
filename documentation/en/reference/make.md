# make commands

The [`Makefile`](https://github.com/Blazheiko/vibe-template/blob/main/Makefile) at the repository root is the single entry point for developer operations. You do not need to remember which command lives in the root `package.json`, which in a package (`pnpm --filter backend …`), and which in `docker compose`: everything runs as `make <target>` from the root.

`make` with no arguments (or `make help`) prints all targets with descriptions, grouped into sections.

::: tip Without make
`make` is optional. Each target only calls a pnpm script, so everything, including running the app, can be done through `pnpm` directly: `make dev` is `pnpm dev`, `make db-migrate` is `pnpm --filter backend db:migrate`, `make app-up` is `pnpm app:up`. The matching script for each target is given in the tables below, and `make -n <target>` prints the command without running it. Full list: [Scripts](/en/reference/scripts).
:::

## How it works

- **The Makefile only delegates.** Each target calls a pnpm script or a file from [`scripts/`](https://github.com/Blazheiko/vibe-template/tree/main/scripts). There is no logic in the Makefile itself, so `pnpm <script>` works the same way. Full list of scripts: [Scripts](/en/reference/scripts).
- **A description is required.** A target appears in `make help` if its line ends with `## description`; a `##@ Name` line opens a group.
- **Layer check.** [`scripts/verify-makefile.mjs`](https://github.com/Blazheiko/vibe-template/blob/main/scripts/verify-makefile.mjs) (`make verify-makefile`, part of `make check`) fails if a target has no description, a target is missing from `.PHONY`, a recipe calls a pnpm script that does not exist in the required `package.json`, or a file from `scripts/` that does not exist.
- **GNU Make 3.81.** This is the version shipped with macOS, so the Makefile does not use `.ONESHELL` or grouped targets. Recipes are indented with tabs, which is fixed in [`.editorconfig`](https://github.com/Blazheiko/vibe-template/blob/main/.editorconfig).

## Parameters

| Variable | Purpose                                                  | Example                           |
| -------- | -------------------------------------------------------- | --------------------------------- |
| `PKG`    | `make test` for a single package (`pnpm --filter <PKG>`) | `make test PKG=backend`           |
| `ARGS`   | extra arguments passed to the script unchanged           | `make db-seed ARGS=--demo`        |
| `PNPM`   | a different command instead of `pnpm`, if needed         | `make check PNPM="corepack pnpm"` |

`ARGS` is supported by the targets where it makes sense: `install`, `prod-local`, `test`, `test-e2e`, `test-pg`, `test-redis`, `services-up`, `db-generate`, `db-seed`, `app-build`. For example, `make test-e2e ARGS="--project=chromium"` or `make app-build ARGS=--no-cache`.

## Getting started

| Target         | What it does                                                                                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup`        | first run: `doctor`, `install`, `env`, `build-shared`                                                                                                                                                                                                    |
| `init`         | session start: `install`, `build-shared`, `check`, `build`. This is exactly what `./init.sh` runs                                                                                                                                                        |
| `doctor`       | [`scripts/doctor.sh`](https://github.com/Blazheiko/vibe-template/blob/main/scripts/doctor.sh): Node `^` the version from `.nvmrc` and pnpm `>=9` are required (otherwise exit code 1); a missing Docker, `.env`, or a busy port are warnings (see below) |
| `install`      | `pnpm install`                                                                                                                                                                                                                                           |
| `env`          | copies `packages/backend/.env.example` to `packages/backend/.env`, only if `.env` does not exist yet                                                                                                                                                     |
| `build-shared` | `pnpm build:shared`: backend/frontend typecheck and tests import the built `shared`                                                                                                                                                                      |

After `make env`, open `packages/backend/.env` and check the values: what is needed for the first run is described in [Quick start](/en/guide/getting-started#_2-the-env-file-for-the-backend).

## Development

| Target           | pnpm script       | What it does                                                             |
| ---------------- | ----------------- | ------------------------------------------------------------------------ |
| `dev`            | `dev`             | builds `shared` and `backend`, runs the backend and frontend dev servers |
| `dev-backend`    | `dev:backend`     | backend only                                                             |
| `dev-frontend`   | `dev:frontend`    | frontend only                                                            |
| `dev-playground` | `dev:manual_test` | backend and API Playground                                               |
| `prod-local`     | `prod:local`      | production-like run: the backend serves the built SPA                    |
| `start`          | `start`           | run the built backend                                                    |

## Quality

`make check` is the same as the check step in the `quality` job in [`ci.yml`](https://github.com/Blazheiko/vibe-template/blob/main/.github/workflows/ci.yml): after `pnpm install --frozen-lockfile`, CI calls exactly `make check`. So a green `make check` locally means a green `quality` in CI (CI counts coverage as a separate step).

| Target                    | What it does                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`                   | runs `build-shared`, `verify-makefile`, `verify-compose`, `format-check`, `typecheck`, `lint`, `check-bundle-graph`, `test` in order; stops at the first error                                                                                                                                                                                 |
| `verify-makefile`         | checks the Makefile itself (see above)                                                                                                                                                                                                                                                                                                         |
| `verify-compose`          | [`scripts/verify-compose.mjs`](https://github.com/Blazheiko/vibe-template/blob/main/scripts/verify-compose.mjs): `docker compose config` gives `app` and `migrate` the same `API_PATH_PREFIX` as `docker-build.sh` (shell → `packages/backend/.env` → `api`), and the healthcheck asks for `/<prefix>/ready`; skipped without `docker compose` |
| `typecheck`               | `pnpm typecheck`                                                                                                                                                                                                                                                                                                                               |
| `lint` / `lint-fix`       | `pnpm lint` / `pnpm lint:fix`                                                                                                                                                                                                                                                                                                                  |
| `format` / `format-check` | `pnpm format` / `pnpm format:check`                                                                                                                                                                                                                                                                                                            |

## Tests

| Target       | pnpm script                             | Note                                    |
| ------------ | --------------------------------------- | --------------------------------------- |
| `test`       | `test` (or `--filter <PKG> test`)       | unit tests of all packages or one       |
| `test-e2e`   | `--filter frontend test:e2e`            | Playwright                              |
| `test-pg`    | `--filter backend test:pg`              | requires PostgreSQL: `make services-up` |
| `test-redis` | `--filter backend test:redis`           | requires Redis: `make services-up`      |
| `coverage`   | `test:coverage` in backend and frontend | like the Coverage step in CI            |

## Services, database and Docker

| Target          | pnpm script           | What it does                                                                                                                     |
| --------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `services-up`   | `services:up`         | PostgreSQL, Redis, S3 and Mailpit from `docker-compose.yml`, waits for healthy; `ARGS="redis s3 mailpit"` — only the listed ones |
| `services-down` | `services:down`       | stops the services and the app, data stays in volumes                                                                            |
| `db-create`     | `backend db:create`   | creates the DB and the `vector` extension                                                                                        |
| `db-migrate`    | `backend db:migrate`  | applies Drizzle migrations                                                                                                       |
| `db-generate`   | `backend db:generate` | generates a migration from the schema                                                                                            |
| `db-seed`       | `backend db:seed`     | initial data; `ARGS=--demo` adds demo accounts                                                                                   |
| `db-studio`     | `backend db:studio`   | Drizzle Studio                                                                                                                   |
| `app-build`     | `app:build`           | builds the `vibe-template:local` image                                                                                           |
| `app-up`        | `app:up`              | services, migrations and the app in compose                                                                                      |
| `app-down`      | `app:down`            | stops and removes only the `app` and `migrate` containers, services keep running                                                 |
| `app-seed`      | `app:seed`            | seed with demo accounts in compose                                                                                               |
| `app-logs`      | `app:logs`            | app log                                                                                                                          |

A sequence for a clean machine: `make setup`, edit `.env`, `make services-up db-create db-migrate`, `make dev`. Targets in a single `make` call run in order from left to right. The same through pnpm: `pnpm install`, `pnpm build:shared`, `pnpm services:up`, `pnpm --filter backend db:create`, `pnpm --filter backend db:migrate`, `pnpm dev`.

After checking the production image (`make app-up`), go back to development like this: `make app-down`, then `make dev`. The app container takes the same port 3000 as `make dev`, and the services stay running after `app-down`.

### Busy ports and your own PostgreSQL

`make doctor` checks (via `lsof`) the ports from `.env` that the stack and dev servers need: `PGSQL_PORT` (5432), `REDIS_PORT` (6379), `S3_HOST_PORT` (8333), `SMTP_PORT` (1025), `MAILPIT_UI_PORT` (8025), `PORT` (3000) and 5173. A port held by Docker is considered normal: the service is most likely already running. If the port is taken by another process, `doctor` warns and names it, for example `port 5432 is taken by postgres (PID 1618)`.

If PostgreSQL with pgvector is already installed locally (for example, via Homebrew), you can work with it and run only the rest in Docker:

```bash
make services-up ARGS="redis s3 mailpit"   # pnpm services:up redis s3 mailpit
```

Other options: stop the local server or set a different `PGSQL_PORT` in `.env` (for example, `5433`) — then the container will listen on it, and the backend will connect to a new empty database (`make db-create db-migrate`).

## Documentation and build

| Target         | pnpm script    | What it does                               |
| -------------- | -------------- | ------------------------------------------ |
| `docs-dev`     | `docs:dev`     | VitePress dev server                       |
| `docs-build`   | `docs:build`   | site build                                 |
| `docs-preview` | `docs:preview` | preview of the built site                  |
| `docs-verify`  | `docs:verify`  | build check: links, anchors, key pages     |
| `build`        | `build`        | build of all packages                      |
| `clean`        | `clean`        | removes build artifacts and `node_modules` |

## Windows

The Makefile and some pnpm scripts are designed for a Unix shell (`sh`, `awk`, `cp`, `rm -rf`, `VAR=value command`, running `./scripts/*.sh`), so they do not work in cmd and PowerShell.

| Environment                    | Status            | Note                                                                                                                                                          |
| ------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WSL2** (for example, Ubuntu) | recommended       | works like Linux; Docker Desktop connects to WSL2. Keep the repository in the WSL file system (`~/…`), not in `/mnt/c/…`: it is faster                        |
| Git Bash + `make`              | not checked in CI | `sh`, `awk` and `cp` come with Git for Windows; `make` is installed separately (`winget install GnuWin32.Make`, `choco install make` or `scoop install make`) |
| cmd / PowerShell               | not supported     | targets with shell syntax (`help`, `doctor`, `env`) and some pnpm scripts (`clean`, `prod:local`, `app:build`) fail                                           |

CI runs only on Linux, so the supported environments are Linux, macOS and WSL2.

## How to add a command

1. Put the logic into a pnpm script of the relevant `package.json` or into a file in `scripts/`.
2. Add a target to the matching Makefile group with a `## …` description and list it in `.PHONY`.
3. Run `make verify-makefile` and check that the target is visible in `make help`.
4. Add a row to the table on this page.
