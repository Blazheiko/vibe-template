# feat-277 — uWebSockets.js v20.72.0

Plan: `docs/plan/uwebsockets-upgrade-plan.md` (rev. 3, PR #904). Branch `chore/uws-20-72`.

## State

| Step                   | State                         | Commit     |
| ---------------------- | ----------------------------- | ---------- |
| 1. Version and patch   | done                          | `a9d6b7d4` |
| 2. Parser/writer tests | done                          | `e46eeb7a` |
| 3. Documentation       | done                          | `4cc40506` |
| 4. Verification (DoD)  | in progress (amd64 smoke, CI) | —          |

## Baseline

`./init.sh` on `origin/main` (`5409dd9c`), before any change: exit 0. Tests: backend 271 files /
3954, frontend 83 / 1029, landing 6 / 103, api-playground 11 / 115.

## Findings while implementing (differ from the plan)

- **Two classes of refusal, not as planned.** A bare-uWS probe shows `Content-Length` ≥ 2^56 is
  refused **after** the route handler is called (handler → `onAborted` → 400), not before it as the
  plan put it. Class 1 (no handler): raw UTF-8 target, `Host` with `/`, `?`, `#`. Class 2 (handler
  called): huge `Content-Length` (our body limit keeps the controller from running), bare-LF
  trailer (the controller may have run; its answer is dropped quietly). Pinned in
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

Still to record: linux/amd64 `prod-smoke` (emulated), CI `quality`, `test-pg`, `test-redis`,
`e2e-live` (x64) on the feature PR.

## Rollback images

Tagged before the first build on this branch (all uWS 20.71.0; `vibe-template-app:uws-20.71-prod`
checked: `linux arm64 abi 137 uws 20.71.0`):

| Tag                                     | Image id                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `vibe-template-app:uws-20.71-prod`      | `sha256:54d215d720054c54fb562feefe67caf6545a996f1ac26bc6d64dcb5764afd8ac` |
| `vibe-template-landing:uws-20.71-prod`  | `sha256:e5a6d2d90e3d6077ae18b79d2b8a5021ee622c3db054f3edb3b25c1ea2a16064` |
| `vibe-template:uws-20.71-local`         | `sha256:ddbdb2c44ca8802a4041f56e075d97b3cdf1713b0d1b86525a1ea6072df3a25b` |
| `vibe-template-landing:uws-20.71-local` | `sha256:5d92f639bb4155fadb0e4d63a30d2fd45487027a73c8818c9af5c05be056d312` |

## Notes for Next Session

- Merging needs the owner's go-ahead (PR #904 and the feature PR).
