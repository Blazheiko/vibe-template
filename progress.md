# feat-140 — Docker Compose For Local Services

## State

Done on branch `feat/feat-140-docker-compose`. Waiting for CI on the feature PR.

## Changes

- New root `docker-compose.yml`: `postgres` (`pgvector/pgvector:pg16`), `redis` (`redis:7-alpine`,
  `requirepass` only when `REDIS_PASSWORD` is set), `s3` (`chrislusf/seaweedfs:4.50` in `mini`
  mode, bucket made on start, anonymous reads only under `S3_BUCKET/S3_PREFIX/`), `mailpit`
  (`axllent/mailpit:v1.31.1`). Every service has a healthcheck; every port binds to `127.0.0.1`.
- Credentials and host ports come from `packages/backend/.env` (`PGSQL_*`, `REDIS_*`, `S3_*`,
  `SMTP_PORT`, plus `S3_HOST_PORT`, `MAILPIT_UI_PORT`); defaults match `.env.example`.
- MinIO is not used: `minio/minio` and `minio/mc` can no longer be pulled from Docker Hub or quay.io.
- Root scripts `services:up` (`docker compose --env-file packages/backend/.env up -d --wait`) and
  `services:down`.
- Docs: `guide/getting-started.md` section "Сервіси через Docker Compose" in place of the
  `docker run` commands; `reference/scripts.md`; `backend/database.md` link; README; hints in
  `packages/backend/.env.example`.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean; `pnpm docs:build && pnpm docs:verify`
- No application code changed, so `pnpm test` is left to CI.
- Manual golden path (stack on alternate ports, the host has its own PostgreSQL/Redis on
  5432/6379): `docker compose up -d --wait` → all four healthy; backend `db:create`,
  `db:migrate`, `db:seed --demo`; `/api/ready` → `ok`; login through CSRF; avatar upload → object
  in the bucket, public read via `CDN_URL` → 200 `image/png`; anonymous list and reads outside
  the prefix → 403; wrong secret → `SignatureDoesNotMatch`; forgot-password mail delivered to
  Mailpit.
