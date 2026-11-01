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

### Not done yet in feat-069

- [x] G2 · Playwright on mocks (`e2e/mock/*`): 60 tests, see below
- [ ] G3 · Playwright on the live backend (`e2e/live/*`): session revocation across two browser contexts (needs Postgres + Redis in CI)

## Evidence of Completion (G1, G2)

| Check                                      | Result                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| New tests                                  | +255 (backend 1430 → 1685), all green, also with `--sequence.shuffle`     |
| Mutations                                  | key / message / error kind / branch / side effect each fail a row         |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                    |
| `pnpm test`                                | backend 1685, frontend 257, api-playground 29, shared 17, docs 26; exit 0 |

## Notes for Next Session

1. Merge the G2 PR; then G3 (Playwright on the live backend, session revocation across two browser contexts)
2. feat-069 stays `in_progress` until G2 and G3 are merged; then a PR flipping it to `done`
