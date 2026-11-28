# feat-277 — uWebSockets.js v20.72.0

Plan: `docs/plan/uwebsockets-upgrade-plan.md` (rev. 3, PR #904). Branch `chore/uws-20-72`.

## State

| Step                   | State                                    | Commit     |
| ---------------------- | ---------------------------------------- | ---------- |
| 1. Version and patch   | done                                     | `a9d6b7d4` |
| 2. Parser/writer tests | done                                     | `e46eeb7a` |
| 3. Documentation       | done                                     | `4cc40506` |
| 4. Verification (DoD)  | done (round 2: amd64 stack, golden path) | —          |

## Baseline

`./init.sh` on `origin/main` (`5409dd9c`), before any change: exit 0. Tests: backend 271 files /
3954, frontend 83 / 1029, landing 6 / 103, api-playground 11 / 115.

## Findings while implementing (differ from the plan)

- **Two classes of refusal, not as planned.** A bare-uWS probe shows `Content-Length` ≥ 2^56 is
  refused **after** the route handler is called (handler → `onAborted` → 400), not before it as the
  plan put it. Class 1 (no handler): raw UTF-8 target, `Host` with `/`, `?`, `#`. Class 2 (handler
  called): huge `Content-Length` (on POST/PUT/PATCH our body limit keeps the controller from
  running; GET and DELETE read no body, so their controller runs), bare-LF trailer (the
  controller runs in every packet split; with `0\r\n` sent before the trailer the client even
  gets our 200 before the close). Checking the abort flag after `readAndParseBody` does not stop
  any of these (tried during review): uWS finds the error after our microtasks, the controller
  included. Same effect as a client that drops the connection mid-request. Pinned in
  `uws-native.transport.spec.ts` (bare uWS) and `uws-parser.transport.spec.ts` (our server);
  documented in `request-lifecycle.md`.
- **vitest fs module cache hides a dependency swap.** `node_modules/.vitest-cache` keeps the
  resolved path of `uWebSockets.js`, and pnpm keeps the old version in `node_modules/.pnpm`. The
  first full run after the bump (3954 green) and the first negative check both ran on the cached
  version. With `vitest --clearCache` the results are real; documented in
  `reference/toolchain.md`. CI does not keep the cache.
- `OPTIONS *` was a 400 on 20.71.0 and reaches `any('/*')` on 20.72.0.

## Evidence of Completion

- Lockfile: `codeload.github.com/uNetworking/uWebSockets.js/tar.gz/c452ac24524cac8eedc6c08b3025038c6e349712`,
  no `patch_hash`, no `patchedDependencies`; installed `package.json` version `20.72.0`; `index.js`
  and `index.mjs` present, `uws.js` gone.
- New tests: 26 pass on 20.72.0. **Negative check** (old package in `node_modules`, cache cleared):
  14 of 26 fail on 20.71.0 — every class-1/huge-`Content-Length` refusal, the three `OPTIONS *`
  cases and the well-formed trailer; the UTF-8, `onWritable` and WS tests pass on both (regression
  guards).
- `pnpm --filter backend test` with a clean cache: 273 files / 3980 tests (3954 + 26).
- `header-values.live.spec.ts` unchanged and green: the edge trimming of bytes above 0x7F is the
  same on 20.72.0.
- Stalled-body timeout re-measured on 20.72.0: 12.0 s, for a stalled request and for one sending a
  byte every 5 s (same as 20.71).
- `pnpm docs:build && pnpm docs:verify`: all checks passed.

- `make check` on `4cc40506`: exit 0. backend 273 files / 3980, frontend 83 / 1029, landing 6 / 103,
  api-playground 11 / 115. The one frontend lint warning is in the baseline too.
- Both runtimes load v20.72.0 through `import * as` and a named `getParts` import and serve a
  request: `node` → `default: function getParts: function GET: ok`, `tsx` → the same; the built
  `dist/vendor/utils/network/http-request-handlers.js` (named import) loads under plain `node`.
  A full `node dist/index.js` start needs PostgreSQL: the local one on 5432 belongs to another
  project and has no `itvibe_template` database, so the full start is covered by `prod-smoke`.
- `pnpm audit --prod --audit-level=high`: no known vulnerabilities.
- **linux/arm64** (`make prod-smoke` on Apple Silicon, image
  `sha256:164d484e1050f9630a074dab53de03e820ae3ccee4c0cf0ef60c5499a35bea52`, tagged
  `vibe-template-app:uws-20.72-arm64`): every check passed (landing 75 checks, `/api/ready` ok,
  `__Host-` Secure cookie, registration, mail, confirmation, sign-in, `main/init`). In the
  container: `linux arm64 abi 137 node v24.22.2 uws 20.72.0`, package has `index.js`/`index.mjs`,
  no `uws.js`. `docker stop` (SIGTERM): stopped in 1 s, exit code 0, log `stop SIGTERM` →
  `server stop type: SIGTERM`.

- **linux/amd64, full stack.** A first try with `DOCKER_DEFAULT_PLATFORM=linux/amd64` built the
  images but could not start the stand-in services (cached here for arm64 only; re-pulling them
  for amd64 would replace tags another project's containers use). The second run puts only our
  services on amd64: `scripts/prod-smoke.sh` run unchanged except for one extra compose file that
  sets `platform: linux/amd64` on `app`, `migrate` and `landing` (built and run under emulation),
  the stand-ins native. Result: **prod-smoke: every check passed** (landing 75 checks,
  `/api/ready` ok, `__Host-` Secure cookie, registration, mail, confirmation, sign-in,
  `main/init`); `app` and `landing` images `amd64`, `postgres` `arm64`. App image
  `vibe-template-app:uws-20.72-amd64`.
- CI on `e2c515a7` (PR #905): `test-pg` 72 files / 724 passed, 0 skipped
  (https://github.com/Blazheiko/vibe-template/actions/runs/46116551814); `test-redis` 22 files /
  231 passed, 0 skipped (https://github.com/Blazheiko/vibe-template/actions/runs/46116551847);
  `e2e` and `build` green.

- `quality` and `e2e-live` green on `e2c515a7`
  (https://github.com/Blazheiko/vibe-template/actions/runs/46116551838): `e2e-live` runs the real
  backend on uWS 20.72.0 (sign-in, sessions, WebSocket close after logout and on revocation, MFA,
  passkeys; `v2/api` prefix: `mfa-continuation.spec.ts` only).
- **Golden path, on both stacks** (scripted through Caddy as a browser does it, on the running
  `prod-smoke` stack, `SMOKE_KEEP=true`): register → mail → confirm → sign in → WebSocket with the
  `wsToken` (`wss://app.localhost:8443/api/websocket`: `service:connection_established`,
  `service:connection_ready`, `broadcast:user_sessions_changed`, heartbeat `ping` → `pong`, a routed
  `api/support/support_open_chat` with `id` → `status=200`) → `POST /api/avatar/upload` of a
  32×32 PNG (CSRF + Origin) → the object read back from S3 with the app's own client
  (`app/uploads/avatars/2/….png`) → `docker stop` (SIGTERM).

    | Stack       | Platform in `app`                 | WS               | Avatar stored = uploaded                         | SIGTERM     |
    | ----------- | --------------------------------- | ---------------- | ------------------------------------------------ | ----------- |
    | linux/amd64 | `linux x64 abi 137 uws 20.72.0`   | all of the above | `image/png` 1796 B, sha256 `297486d0…91380` both | 2 s, exit 0 |
    | linux/arm64 | `linux arm64 abi 137 uws 20.72.0` | all of the above | `image/png` 1796 B, sha256 `297486d0…91380` both | 1 s, exit 0 |

    Logs end with `stop SIGTERM` → `server stop type: SIGTERM`. Not run in a real browser; the
    steps are the browser's requests (`e2e-live` covers the UI side).

## Review round 1 (after `ffb188df`)

- Docs: class 2 now says which methods the body limit protects (POST/PUT/PATCH) and that GET and
  DELETE run their controller; the trailer case in all three packet splits; why an abort check
  does not help. `raw-http.ts` linked like the specs.
- Tests: GET and DELETE with a huge `Content-Length` (our server: the controller has run; bare
  uWS: handler → abort); three trailer splits on both sides, named by what is sent when.
  `exchangeUntilClose` rejects when the connection never opened (`ECONNREFUSED` checked); the
  new `writeLater` drops its timer when the socket closes; `slowDownload` keeps the chunks in a
  list and joins once, fails on a missing `Content-Length` and on an early close; the WS test app
  sets `maxBackpressure`/`maxPayloadLength` to 16 MiB for the 2.2 MiB message.
- The suggested `if (abortSignal.aborted) return` after `readAndParseBody` was tried and changes
  nothing (the controller ran in all five cases), so `server.ts` is unchanged.
- After the fixes: `make check` exit 0 (backend 3986 tests = 3980 + 6), `pnpm docs:build &&
pnpm docs:verify` passed, the two uWS specs 32/32.

## Rollback images

Tagged before the first build on this branch (all uWS 20.71.0; `vibe-template-app:uws-20.71-prod`
checked: `linux arm64 abi 137 uws 20.71.0`):

| Tag                                     | Image id                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `vibe-template-app:uws-20.71-prod`      | `sha256:54d215d720054c54fb562feefe67caf6545a996f1ac26bc6d64dcb5764afd8ac` |
| `vibe-template-landing:uws-20.71-prod`  | `sha256:e5a6d2d90e3d6077ae18b79d2b8a5021ee622c3db054f3edb3b25c1ea2a16064` |
| `vibe-template:uws-20.71-local`         | `sha256:ddbdb2c44ca8802a4041f56e075d97b3cdf1713b0d1b86525a1ea6072df3a25b` |
| `vibe-template-landing:uws-20.71-local` | `sha256:5d92f639bb4155fadb0e4d63a30d2fd45487027a73c8818c9af5c05be056d312` |

## Review round 2 (after `dd4ecae8`)

- P1: amd64 full stack and the golden path, above.
- P2: the bare-uWS suite sends an empty string through the native writer: `res.end('')` →
  `200`, `Content-Length: 0`, no bytes after the headers; `ws.send('')` → an empty message. (The
  `empty` case in `uws-parser` sends `{"text":""}`, which tests our JSON, not the writer.)
- P3: the uWS 400 format is now asserted, not only probed: HTML body `<h1>Bad Request</h1>…`, no
  `Content-Length`, no `access-control-*` (also with CORS on and an allowed `Origin`), no
  `content-security-policy` / `x-content-type-options` / `x-frame-options`. The docs no longer say
  a write to the closed connection is "quiet": `setHttpHandler` sees `abortSignal.aborted` before
  `sendResponse` and writes nothing; when our answer went out first (the `0\r\n` trailer case),
  the client gets it.
- Process order fixed below (AGENTS.md: `review` before the implementation merge).
- After the fixes: `make check` exit 0 (backend 3989 tests = 3986 + 3), `pnpm docs:build &&
pnpm docs:verify` passed, the two uWS specs 35/35.

## Notes for Next Session

Order (AGENTS.md, Team Coordination and Definition of Done), each step needs the owner's go-ahead
to merge:

1. Merge #904 (plan + `feat-277` registry entry, `in_progress`).
2. A coordination PR to `main` that sets `feat-277` to `review` (not from this branch); merge it.
3. Review and merge #905 (this branch).
4. A "Mark feat-277 done" PR: status `done`, the permanent evidence in `evidence`, and
   `feature-state/feat-277/` deleted.
