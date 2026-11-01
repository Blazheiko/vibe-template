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

### Not done yet in feat-069

- [ ] G2 · Playwright on mocks (`e2e/mock/*`): login / register / forgot password / modal state / client validation
- [ ] G3 · Playwright on the live backend (`e2e/live/*`): session revocation across two browser contexts (needs Postgres + Redis in CI)

## Evidence of Completion (G1)

| Check                                       | Result                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| New tests                                   | +255 (backend 1430 → 1685), all green, also with `--sequence.shuffle`     |
| Mutations                                   | key / message / error kind / branch / side effect each fail a row          |
| `pnpm typecheck` / `lint` / `format:check`  | exit 0                                                                    |
| `pnpm test`                                 | backend 1685, frontend 257, api-playground 29, shared 17, docs 26; exit 0 |

## Notes for Next Session

1. Merge the G1 PR; then G2 (Playwright projects `mock`, then `live`)
2. feat-069 stays `in_progress` until G2 and G3 are merged; then a PR flipping it to `done`
