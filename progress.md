# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-073 - One-Time Token Module (in progress, H4)
**Branch:** `refactor/one-time-token-module`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase H4

## Status

### Done

- [x] **Repositories.** `repositories/auth/token-repository.ts`: `createTokenRepository(table, createFailure)` gives `create`, `findByTokenHash`, `invalidatePendingByUserId` and the claiming `markUsed` (`UPDATE … WHERE id = ? AND used_at IS NULL`) for the three tables; `passwordResetRepository`, `emailVerificationRepository` and `emailLinkVerificationRepository` are one call each. The three tables stay three (merging them would be a migration for no gain). drizzle cannot resolve a union of tables, so the factory looks at them as one inside, with the casts confined there; what comes out is typed by the table that went in
- [x] **Services.** `services/auth/one-time-token.ts`: `hashToken`, `createToken`, `issueToken` (retire the old tokens, then store the hash of a new one), `findUsableToken` (not found → `undefined`; used → its error; expired → burnt and its error) and `consumeTokenAndApply` (claim + effect in one transaction; a lost claim → `{ claimed: false }`; a failing effect → the 500 with the cause kept, which is how the unique violation of an e-mail link is told apart). Used by `passwordResetService` (issue, consume) and `emailVerificationService` (issue ×2, consume ×2, with the fall-back from the verification table to the link table kept in the caller: the one place where "not found" means "look elsewhere")
- [x] The plan's name `consumeTokenAndApply` of B2 is generalised, not renamed; `ITokenRepository` is exported by the barrel (the layering spec requires repositories to be reached through it)
- [x] **Net, untouched:** `one-time-token-race.pg.test.ts` (9 tests on real PostgreSQL: concurrent claims, fault injection, rollback) and all 456 auth specs, the G1 tables among them. `one-time-token.spec.ts` (13) pins the shared part: issue order and that only the hash is stored, usable / used / expired / burn failures, claim lost, failing effect
- [x] Mutations (PG + unit): claim without `used_at IS NULL` fails 3 of 9 PG tests and **no** unit spec, so the PG tests are what guard the claim; ignoring a lost claim, no expiry check and the claim outside the transaction fail PG tests and 6 / 5 / 8 unit specs
- [x] Docs: `backend/repositories.md`

### Notes

- `markUsed(id, usedAt?, executor?)` and the other repository method signatures are unchanged for callers
- `IPasswordResetRepository` and the two others are now type aliases of `ITokenRepository<Row, Insert>` instead of three copies of one interface

## Evidence of Completion

| Check                                      | Result                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| Race / fault-injection PG tests            | 9 passed, unchanged                                                     |
| Auth specs, unchanged                      | 456 passed                                                              |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                  |
| `pnpm test`                                | backend 1712 (+13), frontend 257, api-playground 29, shared 17, docs 26 |
| `test:pg`                                  | 84 passed, 64 skipped (no Redis here)                                   |
| `docs:build && docs:verify`                | passed                                                                  |

## Notes for Next Session

1. Merge this PR; then a PR flipping feat-073 to `done` and starting feat-074
2. Next: H5 (feat-074, `sms-challenge.ts`): issue/verify of SMS challenges in auth and password reset; the G1 phone rows and `auth-phone-foundation.spec.ts` are the net
