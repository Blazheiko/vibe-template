# feat-153 — Docker API Prefix Build Arg (V07)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V07), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (V07.S–V07.X). Finding M6 of
`docs/plan/code-review-2026-11-10-report.md`.

## Goal

The API prefix is compiled into the SPA (`VITE_API_PATH_PREFIX`), the server reads its own at run
time (`API_PATH_PREFIX`). The Dockerfile declared build args only for `VITE_SENTRY_*` and
`.dockerignore` strips every `.env`, so the image always carried a SPA built for `api`: a container
started with `API_PATH_PREFIX=v1` served a SPA whose calls never reached the API, with nothing in
the log to say why.

## State

Done, waiting for review and merge.

## What changed

- `Dockerfile` — build args `VITE_API_PATH_PREFIX`, `VITE_BASE_URL`, `VITE_AUTH_PHONE_ENABLED`
  (the other `VITE_*` values the SPA reads; they were ignored the same way).
- `scripts/docker-build.sh` (`pnpm app:build`) — passes `VITE_API_PATH_PREFIX` from
  `API_PATH_PREFIX` in `packages/backend/.env` (or the environment), the same file the container
  reads at run time through compose.
- `packages/frontend/vite.build-meta.ts` (new) + `vite.config.ts` — the build writes
  `build-meta.json` next to `index.html` with the prefix the SPA was built for.
- `packages/backend/src/vendor/start/static-build-meta.ts` (new) + `static-server.ts` — at startup
  with `SERVE_STATIC=true` the server compares that prefix with its own and logs an error on a
  mismatch (`builtFor`, `served`); it still starts. No file → no verdict.
- Docs (both locales): `backend/deployment.md`.

`docker-compose.yml` is unchanged: its `app` service runs a prebuilt image and has no `build`
section, so the build script is where the two values meet (task V07.2 assumed a compose build).

## Evidence of Completion

### V07.T — RED (manual, Docker Desktop, macOS)

The Dockerfile of `main` with the build arg (the new Vite plugin in the build context serves as
the probe):

```
$ docker build -f Dockerfile.main --build-arg VITE_API_PATH_PREFIX=v1 -t vibe-template:v07-red .
$ docker run --rm --entrypoint sh vibe-template:v07-red -c 'cat public/build-meta.json'
{"apiPathPrefix":"api"}
```

The build arg is ignored: the SPA is built for `api`.

### After the fix

```
$ API_PATH_PREFIX=v1 APP_IMAGE=vibe-template:v07-v1 ./scripts/docker-build.sh
Building vibe-template:v07-v1 (revision 15488a0-dirty, API prefix v1)
$ docker run --rm --entrypoint sh vibe-template:v07-v1 -c 'cat public/build-meta.json'
{"apiPathPrefix":"v1"}
```

The same image, started twice against the local PostgreSQL (pgvector container) and Redis with
the settings compose gives the `app` service:

|                                         | `API_PATH_PREFIX=v1` (match)             | `API_PATH_PREFIX=api` (mismatch)                                                                          |
| --------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /<prefix>/ping`                    | 200                                      | 200                                                                                                       |
| `GET /` (SPA)                           | 200                                      | 200                                                                                                       |
| what the SPA calls: `GET /v1/main/init` | `401 application/json` (the API answers) | `200 text/html` (the SPA shell, not the API)                                                              |
| startup log                             | no mismatch entry                        | `ERROR The SPA in the static directory was built for another API prefix …  builtFor: "v1"  served: "api"` |

- `scripts/docker-build.sh` reading the prefix from the env file, checked on sample files:
  `v1`, `"v2"`, `'v3'`, spaces around `=`, a commented line (ignored), no line, two lines (the
  last wins), no file.
- `pnpm --filter frontend build`: `dist/build-meta.json` is `{"apiPathPrefix":"api"}` by default
  and `{"apiPathPrefix":"v1"}` with `VITE_API_PATH_PREFIX=/v1/`.
- `static-build-meta.spec.ts`: 8 passed (match, mismatch, six kinds of unreadable file).
- `make check` (shared build, Makefile check, format, typecheck, lint, test): backend 194 files /
  2605 tests, frontend 432, api-playground 62.
- `pnpm docs:build && pnpm docs:verify`: passed.

### Not verified

- The SPA of the matching image was not opened in a browser; the check is the HTTP answer to the
  path the SPA calls.
- `VITE_BASE_URL` and `VITE_AUTH_PHONE_ENABLED` as build args were not exercised in an image.
- The Vite plugin has no unit test of its own; it is covered by the two builds above.

### Notes from the manual run

- A second image build failed once because branches were switched while Docker was copying the
  build context (`tsconfig.base.json` missing). Not a defect of the Dockerfile.
- `docker run --env-file packages/backend/.env` does not strip the quotes of quoted values (compose
  does), so the container refuses to start on `DOMAIN="…"` / `CDN_URL="…"`. The run above used a
  dequoted temporary copy. `documentation/backend/deployment.md` tells readers to use their own
  `production.env`, so this only bites when a developer `.env` with quotes is reused.

## Notes for Next Session

- The image HEALTHCHECK still knows only the `api` prefix (documented: override `--health-cmd`).
