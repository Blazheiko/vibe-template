# feat-145: Makefile Service Control

## State

Done, waiting for review. Start PR: #468.

## Changes

- `package.json`: new script `app:down` (`docker compose --profile app rm --stop --force app migrate`).
- `Makefile`: `make app-down`; `make services-up` passes `ARGS` to `docker compose up`, so
  `make services-up ARGS="redis s3 mailpit"` starts a subset (e.g. next to a local PostgreSQL).
- `scripts/doctor.sh`: checks the host ports from `.env` (PGSQL_PORT, REDIS_PORT, S3_HOST_PORT,
  SMTP_PORT, MAILPIT_UI_PORT, PORT, 5173) with `lsof`; Docker-held ports are ok, any other holder
  is a warning that names the process and the fix.
- Docs: README, AGENTS.md, `reference/make.md` (pnpm alternative tip, app-down, busy ports and a
  local PostgreSQL), `reference/scripts.md`, `guide/getting-started.md` (pnpm-only tip, app-down,
  busy ports).

## Evidence of Completion

- `make check` (format:check, typecheck, lint, test, verify-makefile: 43 targets): exit 0.
- `pnpm docs:build && pnpm docs:verify`: all checks passed.
- Manual (2026-11-06, Docker Desktop, Compose v2.32.4):
    - `make services-down`, then `make services-up ARGS="redis s3 mailpit"`: only redis, s3 and
      mailpit run.
    - `make app-up`: all services, migrate (exit 0) and app healthy; `make app-down` removes app and
      migrate, the four services stay healthy, port 3000 is free. `make app-down` with no app
      container: exit 0.
    - `make doctor`: Docker-held ports reported as ok; a node listener on 5173 gives
      `warn port 5173 is taken by node (PID …)`; earlier a Homebrew PostgreSQL on 5432 made
      `services-up` fail with `address already in use`, the case this warns about.

## Notes for Next Session

None.
