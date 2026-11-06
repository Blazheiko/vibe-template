# feat-142: App in Docker Compose

## State

Done, waiting for review. Start PR: #459.

## Changes

- `docker-compose.yml`: `migrate` (one-shot `db:create:prod && db:migrate`) and `app` services under the
  `app` profile, image `${APP_IMAGE:-vibe-template:local}` with `pull_policy: never`. Shared environment
  (`x-app-environment` anchor) overrides what differs inside the compose network: service host names and
  container ports, one origin `http://localhost:APP_PORT`, `APP_ENV=local`, `SERVE_STATIC=true`, S3 keys
  and bucket matching the `s3` service, `CDN_URL` on the host port, Mailpit SMTP, empty
  `CSRF_ALLOWED_ORIGINS`/`CSP_*_ORIGIN` (derived from `APP_URL`/`DOMAIN`). Infra services unchanged.
- `scripts/docker-build.sh` (`pnpm app:build`): builds the local image from the production Dockerfile,
  tag `APP_IMAGE`, git revision label, Sentry off, extra args passed to `docker build`.
- `package.json`: `app:build`, `app:up`, `app:seed`, `app:logs`; `services:down` now also stops the app.
- Docs: getting-started (new section "Увесь застосунок у Docker Compose"; fixed the stale curl login body:
  `identifier`, `token` optional), deployment, reference/scripts, README, `.env.example` (`APP_PORT`).

## Evidence of Completion

- `pnpm typecheck` clean; `pnpm lint` clean; `pnpm format:check` clean.
- `pnpm test`: backend 2555, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify`: all checks passed.
- Manual (2026-11-06, Docker Desktop, macOS; separate project on alternate ports, torn down with `down -v`):
    - `pnpm app:build` builds `vibe-template:local` in ~70 s;
    - `up --profile app -d --wait` exit 0: postgres/redis/s3/mailpit healthy, `migrate` exited 0, `app` healthy;
    - `app:seed` command inserts prompts and a demo user;
    - `/api/ready` → ok; `/` → SPA with CSP (`connect-src` app origin + ws, `img-src` CDN_URL);
    - login via CSRF works; with `CSRF_ENFORCE=true` a foreign origin gets `403 origin_mismatch`;
    - avatar upload to SeaweedFS, public read from `CDN_URL` → 200 image/png;
    - forgot-password mail in Mailpit, link to `http://localhost:<APP_PORT>/reset-password`;
    - WebSocket `ws://localhost:<APP_PORT>/api/websocket` opens, `connection_established`;
    - infra-only `up` starts only the four services; `down --profile app` removes the app too;
    - a missing image fails with `No such image: vibe-template:missing`.

## Notes for Next Session

None.
