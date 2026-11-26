# feat-218: Production Compose And Dokploy Deployment — progress

## Current state

Steps 2–6 of `docs/plan/prod-compose-dokploy-plan.md` are done; waiting for CI and review. Step 7
(a deploy by the owner on Hetzner + Dokploy) has not been run: the guide carries
`::: warning Не перевірено` / `Not verified`.

## What changed

- `docker-compose-prod.yml`: `migrate` (one-shot `db:create:prod && db:migrate`), `app` (root
  Dockerfile) and `landing` (packages/landing/Dockerfile). No PostgreSQL / Redis (Database services
  of Dokploy, Д2), no `ports` (`expose`), no volumes, no Traefik labels; `app` and `migrate` on the
  external `dokploy-network`; healthchecks, `restart: unless-stopped`; required values as
  `${VAR:?…}`; addresses, `CSRF_ALLOWED_ORIGINS` and `WEBAUTHN_RP_ID` derived from `APP_DOMAIN` /
  `LANDING_DOMAIN`; one `API_PATH_PREFIX` for the SPA build and the server; `env_file: .env`
  (`required: false`) passes the optional variables.
- `.env.prod.example` (un-ignored in `.gitignore`): every variable of the compose file with
  comments; secrets are empty on purpose.
- `scripts/verify-compose-prod.mjs` (rules) + `verify-compose-prod.test.mjs` (broken copies: ports,
  a database service and volumes, different prefixes, landing addresses, network, healthcheck /
  restart / production mode / Traefik labels), run by `scripts/verify-compose.mjs` (part of
  `make check`) and by `pnpm test` (`scripts/*.test.mjs`).
- `docker-compose-prod.smoke.yml` + `scripts/prod-smoke.sh` + `pnpm prod:smoke` / `make prod-smoke`:
  Caddy with `tls internal` on `https://{app,landing}.localhost:8443`, postgres (pgvector), redis
  with a password, SeaweedFS, Mailpit, a local `dokploy-network` with a fixed subnet.
- Docs: `documentation/guide/deployment-dokploy.md` (uk + en), sidebars, `KEY_PAGES` /
  `EN_KEY_PAGES`, links from `backend/deployment.md`, `landing/index.md` (the «План» warning
  replaced), `reference/make.md`, `reference/scripts.md`, README, the header of
  `docker-compose.yml`.

## Deviations from the plan

- `docker compose -f docker-compose-prod.yml --env-file .env.prod.example config` does not pass as
  is: the example keeps the secrets empty, so a pasted template cannot deploy with placeholder
  secrets. `verify-compose` fills the empty required values with `placeholder` before `config`.
- The smoke run confirms the email from the Mailpit message before the sign-in: registration is
  strict (`AUTH_STRICT_REGISTRATION=true`).
- `*.localhost` works in production mode (risk in the plan): only `WEBAUTHN_RP_ID` is set to the
  host without the port in the smoke override.

## Evidence of Completion

- `make prod-smoke`: exit 0 — landing (`verify-landing-deploy.sh --insecure --allow-local`),
  `/api/ready`, `__Host-` + `Secure` cookie, registration, verification mail, email confirmed,
  sign-in, signed-in `main/init`: 8 checks ok.
- `make check`: exit 0 — `verify-compose` passes the production file; backend 3899, frontend
  1029, landing 103, api-playground 115; scripts tests 20 passed.
- `pnpm docs:build && pnpm docs:verify`: all checks passed.
- Step 7 (real server): not done — to be run by the owner with the guide.

## Notes for Next Session

Record the CI run, set `review`, merge, then "Mark feat-218 done" (evidence notes that the real
deploy is still pending). Later, after the owner's deploy: fix the guide by the result, check
`X-Forwarded-For` behind Traefik, remove the «Не перевірено» warning.
