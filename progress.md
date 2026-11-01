# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-071 - Auth Normalizers (in progress, H2)
**Branch:** `refactor/auth-normalize`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase H2

## Status

### Done

- [x] `app/services/auth/auth-normalize.ts`: `normalizeEmail`, `normalizePhone` (the 400-wrapping one), `isChallengeExpired`, and the three phone flows (`REGISTER_PHONE_FLOW`, `LINK_PHONE_FLOW`, `RESET_PHONE_FLOW`)
- [x] Copies removed: `auth-service.ts` (4), `password-reset-service.ts` (flow constants, `normalizePhone`, `isChallengeExpired`, the inline `trim().toLowerCase()` of `requestPasswordReset`), `email-verification-service.ts` (two `toLowerCase()`), `oauth-service.ts` (one), `db/seed/run-seed.ts` (its own `normalizeEmail`, which was exported but imported by nobody)
- [x] **The table is the old behaviour, not a reading of the new code**: `auth-normalize.spec.ts` compares `normalizeEmail` with the old expression `trim().toLowerCase()` over 13 edge inputs (case, tabs, newlines, NBSP, em space, German umlauts, Turkish İ, Greek final sigma, `+tag`, `@@`, empty, blanks) and checks idempotence; the phone helper is checked on formats (spaces, brackets, dashes, country default) and on every refusal text; the expiry on the boundary (`<=`); the flow values against the challenge table
- [x] All 469 auth and db specs pass **unchanged** (G1 tables included)
- [x] Mutating the module (`<` instead of `<=`, no `trim`, a flow renamed) fails 1 / 13 / 18 specs

### Notes

- `normalizeEmail` stays in the backend: the frontend does not normalise e-mails (only `trim()`), so the plan's condition for moving it to `shared/utils` does not hold
- Two copies did not trim: the target address of an e-mail link in `email-verification-service.ts` (read back from the database, where `startEmailLink` stored it normalised) and the provider address in `oauth-service.ts`. They now trim too: a no-op for the first, and for a provider address that arrives with a stray space it now finds the account instead of creating a second one. This is the only place where input that differed could give a different result
- `mask-sensitive.ts` keeps its own `trim().toLowerCase()`: it masks for logs and is not an auth rule
- `db/seed` now imports `app/services/auth/auth-normalize.ts`; the built seed (`dist/db/seed/run-seed.js`) was checked to load

## Evidence of Completion

| Check                                      | Result                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| Auth + db specs without any change         | 469 passed                                                                  |
| Mutations of the module                    | 1 / 13 / 18 failures                                                        |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                      |
| `pnpm test`                                | backend 1691 (+28 new), frontend 257, api-playground 29, shared 17, docs 26 |
| `test:pg`                                  | 84 passed, 64 skipped (no Redis here)                                       |
| `docs:build && docs:verify`                | passed                                                                      |

## Notes for Next Session

1. Merge this PR; then a PR flipping feat-071 to `done`
2. Next: H3 (feat-072, shared `renderBrandedEmail`; the G1 snapshots must stay byte-identical)
