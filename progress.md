# feat-207: Supply Chain Pinning

Step S13 of `docs/plan/security-review-2026-11-12-plan.md` (decision Д7). Findings L-18, L-19,
I-4, I-5 of `docs/security/security-review-2026-11-12.md`.

## Current State

Done, ready for review.

## What Changed

- **L-18, Dockerfile.** Both stages are `FROM ubuntu:24.04@sha256:2198e4c6…`. Node comes from the
  NodeSource apt repository the Dockerfile adds itself: the signing key is downloaded to
  `/etc/apt/keyrings/nodesource.asc` and checked against `NODESOURCE_ASC_SHA256`, apt checks the
  packages against the key. `curl … setup_24.x | bash` is gone. Dependabot (`docker`) moves the
  digest.
- **L-19, dependencies.** `pnpm.onlyBuiltDependencies: ["esbuild"]` in the root `package.json`.
  Dependabot `npm` with `open-pull-requests-limit: 0` (security updates only; the toolchain is
  pinned on purpose). New `.github/workflows/audit.yml`: weekly and on demand,
  `pnpm audit --prod`, fails on high or critical.
- **I-5.** The production stage no longer copies `public-test`; the docs say `manual-test` is a
  local mode.
- **I-4.** The `uWebSockets.js` tarball without an integrity hash is recorded as accepted in
  `docs/plan/dependency-upgrade-plan.md`.
- `docs/plan/docker-hardening-plan.md` has a section on the pinning.

## Files Modified

- `Dockerfile`, `package.json`, `.github/dependabot.yml`, `.github/workflows/audit.yml` (new)
- `documentation/backend/{deployment,caching-etag,routing}.md` and the same pages under
  `documentation/en/backend/`
- `docs/plan/docker-hardening-plan.md`, `docs/plan/dependency-upgrade-plan.md`

## Evidence of Completion

- `make check`: passed (backend 2967, frontend 577, api-playground 115).
- `pnpm docs:build && pnpm docs:verify`: passed.
- `pnpm install --frozen-lockfile`: "Lockfile is up to date", no warning about ignored build
  scripts. Only `esbuild` (0.25.12, 0.28.2) has a lifecycle script in the installed tree;
  `uWebSockets.js` has none, so it is not in the list.
- **Docker.** `APP_IMAGE=vibe-template:feat-207 pnpm app:build` passes: the log shows the base
  image resolved by digest, `/etc/apt/keyrings/nodesource.asc: OK`, and the `esbuild`
  postinstall running in the builder stage (the frontend build that needs it passes).
  `pnpm app:up` with that image: migrations run, the container becomes `healthy`,
  `GET /api/ready` answers `{"status":"ok"}`, `/` answers 200. In the container:
  `node -v` is `v24.22.2`, `nodejs` is `24.22.2-1nodesource1` from the signed repository,
  `public-test` does not exist, the process user is `app`.
- **Negative control.** `docker build --build-arg NODESOURCE_ASC_SHA256=000…0` stops with
  `/etc/apt/keyrings/nodesource.asc: FAILED`, exit code 1.
- `pnpm audit --prod --audit-level=high`: exit 0 (what the workflow's failing step runs).

## Notes

- The audit reports 7 advisories below `high` today (6 moderate, 1 low), all in `hono` and
  `@hono/node-server`, which come only through `@mistralai/mistralai@3.4.0`. They do not fail
  the workflow and are not fixed here.
- Dependabot security pull requests for `npm` need "Dependabot security updates" enabled in the
  repository settings; this was not checked. The weekly audit does not depend on it.
- `audit.yml` runs on a schedule and on demand only, so it has not run in CI yet; its two
  commands were run locally.
- The argument was first named `NODESOURCE_KEY_SHA256`; the Docker build check
  `SecretsUsedInArgOrEnv` flagged the name, so it is `NODESOURCE_ASC_SHA256`.
- `curl` stays in the runtime image: `HEALTHCHECK` uses it.

## Next Step

Merge, then mark `feat-207` done on `main`.
