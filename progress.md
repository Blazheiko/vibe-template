# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-069 - Auth Regression Coverage (in progress)
**Branch:** `test/auth-regression-coverage`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase G (G1 backend contract tables, G2 e2e on mocks, G3 e2e on the live backend)

## Status

### Done

- [x] **G1 · backend contract tables** (this PR). Nothing in `src/` changed; only tests
    - `auth-service.throttle-contract.spec.ts`, `password-reset-service.throttle-contract.spec.ts`, `email-verification-service.throttle-contract.spec.ts`: one row per throttle step (24 steps, the ones `enforceThrottle()` replaces in H1). Per row: the counters consumed up to and including the one under test (**scope + key + order**), the answer for a spent counter (status, code, message), the answer for a Redis failure (500 + its own message) and for an unreachable Redis (503), and that nothing downstream ran. Forgot-password is pinned on its own (it never fails, whatever the counters say)
    - `auth-service.contract.spec.ts` (71 rows), `password-reset-service.contract.spec.ts` (51), `email-verification-service.contract.spec.ts` (35): state → answer for every other branch of the public methods — status, code, message, reason, the writes and the side effects (session tokens rotated, sessions dropped, notices sent, challenges invalidated, token burnt, one transaction for claim + effect)
    - `auth-email-templates.snapshot.spec.ts`: subject + text + html of the three mails (password reset, e-mail verification, e-mail linking) for a plain name, a name with markup and a blank name, as files in `__snapshots__/` (the token is masked); H3 must not change a byte
- [x] The consistency tests of B2 (`one-time-token-race.pg.test.ts`) and the session-revocation tests (`*.pg.test.ts`) already exist and stay as they are: they are the "regression on `consumeTokenAndApply`" of G1
- [x] The tables were written **against the current code, not the other way round**; each was checked by mutating the service (a key, a message, an error kind, a branch) and confirming a row fails. Shuffled order (`--sequence.shuffle`) passes: `vi.resetAllMocks()` between tests, no row relies on another

- [x] **G2 · Playwright on mocks** (second PR, `test/auth-e2e-mock`). Nothing in `src/` changed
    - New Playwright project `mock` (chromium) in `playwright.config.ts` with its own `webServer`: a separate build of the SPA (`dist-e2e-mock/`) with `VITE_AUTH_PHONE_ENABLED=true`, `VITE_BASE_URL` = its own origin and Sentry off, served on 4174. The other projects `testIgnore` `mock/**`. The result does not depend on a developer's `.env` (which is untracked; CI has none, so phone auth is off in the CI build of the other projects)
    - `e2e/mock/support.ts`: fixture `api`: `main/init` answers "anonymous + CSRF token" (or a signed-in user after `setSession`), every other `/api` request is answered by the test (`api.answer`) and **a request nobody answered fails the test**
    - `login.spec.ts` (15): success (trimmed identifier, one request, modal closes, `/account`), phone identifier, 401, the 401 of a spent throttle reads like a wrong password, 429 / 500 / 503 show the server text, double click = one request, Enter does nothing (the step is not a `<form>`), 6 client-side validation rows without a request
    - `forgot-password.spec.ts` (17): e-mail (carry-over of the typed value, generic text for 200/400/404/422, 429 and 500 texts, double click, validation) and phone (`reset-phone/start` → code step → `complete`, wrong code, right code returns to sign-in with a notice, validation, back)
    - `register.spec.ts` (19): choice step, e-mail (strict answer shown in the form-error slot, non-strict signs in, 400 / 500, double click, three validation rows) and phone (start with / without country, resend cooldown 429, confirm wrong / empty / double click, whole path, complete validation, back links)
    - `modal-state.spec.ts` (9): open / close and the routes `/login` `/register` `/`, state reset on reopening, switching between the modals
    - Where the UI differs from the plan's wording, the row records what it does: there is **no phone login code step** (phone _login_ is identifier + password; the SMS steps are registration and password reset), **no resend timer** (the step prints the ISO time), **no 429-specific text on login**, the register/login steps are **not forms**
    - Checked by mutating `AuthModals.vue` (password minimum, the forgot 429 branch, the disabled button, the trim of the name): four of five fail rows; the fifth (not clearing on close) is an equivalent mutation, because the state is also cleared on opening

- [x] **G3 · Playwright on the live backend** (third PR, `test/auth-e2e-live`). Nothing in `src/` of backend or frontend changed
    - Own config `playwright.live.config.ts` and directory `e2e-live/` (like `e2e-security/`; the plan said a project under `e2e/live/`, but this one needs a backend, a database and a build of its own, so it cannot share the `webServer` of `test:e2e`). Script `test:e2e:live`; CI job `e2e-live` with PostgreSQL (pgvector) and Redis services, chromium only
    - The `webServer` first makes the database (`db:create`, `db:migrate`, `db:seed --demo`; Playwright starts it **before** any `globalSetup`), then the backend through `scripts/prod-local.sh` with `CSRF_ENFORCE=true`. A database (`vibe_e2e_live`) and a Redis key prefix (new per run) of its own; the SPA is built without phone auth with its API base at `http://localhost:3100` (the base is baked in at build time: `PORT=3100` goes to the build too)
    - `e2e-live/mail-sink.ts`: a minimal SMTP server (no dependency; checked against nodemailer, long lines and quoted-printable); the backend sends to it with `SMTP_IGNORE_TLS=true`
    - Every browser is its own device: `X-Forwarded-For` of its own (`TRUST_PROXY` for localhost only). Without it all browsers are 127.0.0.1 and the 10-a-minute limit of the `auth` route group stops the run
    - `session-revocation.spec.ts` (3): a password **reset by mail** signs two other browsers out (API 401 and the page shows the sign-in), old password dead, new works, link single-use; **change password** on the account page keeps this browser in, signs the other out and **ends the other browser's live WebSocket** (checked that it had one); **log out everywhere** ends every session, the password still works
    - `registration.spec.ts` (2): register → mail → confirm → sign in; the early login with the right password is `401` and sends a **second mail whose link makes the first one invalid** (feat-066 behaviour, now pinned); the registration counter per address is real (4th try in an hour → 400)
    - Passes three times in a row (≈17 s) and without `packages/backend/.env` (PG, Redis and `APP_KEY` from the environment, as in CI). Not left to a developer's `.env`: `AUTH_STRICT_REGISTRATION=true`, `AUTH_PHONE_ENABLED=false`
    - Mutation: with the whole revocation of `changePassword` removed (no token rotation, no cleanup) the spec fails; with only the check of the session token (`checkSessionToken`) forced to `ok` it still passes, because the Redis cleanup revokes too — each mechanism alone is pinned by `session-revocation*.pg.test.ts` (ADR 0002), the live spec pins the end result
    - Finding for J (not fixed here): right after a successful sign-in the page is now and then left on the home page instead of `/account` (the modal's `close` replaces the route while the sign-in pushes `/account`); `loginInUi` in `e2e-live/support.ts` opens `/account` itself so that the specs do not depend on it

## Evidence of Completion (G1, G2)

| Check                                      | Result                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| New tests                                  | +255 (backend 1430 → 1685), all green, also with `--sequence.shuffle`     |
| Mutations                                  | key / message / error kind / branch / side effect each fail a row         |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                    |
| `pnpm test`                                | backend 1685, frontend 257, api-playground 29, shared 17, docs 26; exit 0 |

## Notes for Next Session

1. Merge the G3 PR (its CI job `e2e-live` is new: watch its first run); then flip feat-069 to `done`
2. feat-069 stays `in_progress` until G2 and G3 are merged; then a PR flipping it to `done`
