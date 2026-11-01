# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-060 - One-Time Token Race
**Branch:** `fix/one-time-token-race`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase B2 (depends on feat-059, done)

## Status

### Done

- [x] Diagnosis: the password-reset, email-verification and email-link tokens were read, checked (`usedAt === null`), applied, and only then marked used with `UPDATE … WHERE id = ?` (no `used_at IS NULL`). Two concurrent requests with one token both passed the check and both applied it; a failure of the last step left the effect committed and the link reusable (replay)
- [x] Tests first (`one-time-token-race.pg.test.ts`, real PostgreSQL): both requests are held after reading until the second has read too (the race made deterministic); a write that succeeds and then fails; `markUsed` failing. 7 of 9 failed before the fix ("exactly one winner" got two in all three flows; the password / email stayed changed after a failure), 2 regression cases (already used, expired) passed
- [x] `markUsed` of the three token repositories is now a claim: `UPDATE … SET used_at WHERE id = ? AND used_at IS NULL RETURNING *`, `undefined` when it was already used
- [x] `withTransaction` + optional `executor` (`DbExecutor`) on `markUsed` and `userRepository.update` (`app/repositories/transaction.ts`); `userRepository.update` is a single `UPDATE … RETURNING` now instead of an update plus a separate read
- [x] `resetPassword` (email), `verifyEmail` (confirmation and email link): claim the token and apply its effect (password + rotated `sessionToken`, `emailVerifiedAt`, new email) in ONE transaction. A lost claim answers "already used" (`used_token` for the reset); a failure after the write rolls both back and the link still works. `destroyAllSessions` runs after the commit (best-effort, ADR 0002)
- [x] Unit specs updated for the transaction argument, plus lost-claim cases; one HTTP-level test (two concurrent `POST /auth/reset-password`, exactly one 200, the loser `400 used_token`, the stored password is the winner's), stable over repeated runs
- [x] Docs: `backend/repositories.md` (new «Транзакції» section, rule on single-use tokens), `backend/auth.md`

### Out of scope, checked

The phone reset (`completePhonePasswordReset`) already claims the SMS challenge with the conditional `markConfirmed` (`confirmed_at IS NULL AND invalidated_at IS NULL AND expires_at > now`) before it changes the password, so it cannot be applied twice; a failure after the claim only burns the code. Making it transactional belongs to H5 (SMS challenge).

### Behaviour changes to know

- A reset or verification link used by two requests at once now succeeds once; the other gets `400` ("already been used").
- A failure while applying a link no longer leaves half the effect committed: the link stays usable and nothing changed.
- An expired link is still marked used outside any transaction, as before.

## Evidence of Completion

| Check                                                 | Result                                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| New tests before the fix                              | 7 failed / 2 passed (`expected [ …(2) ] to have a length of 1 but got 2` in all three flows; password / email still changed after a failure) |
| Mutation check (`markUsed` without `used_at IS NULL`) | the deterministic race test and the HTTP race test fail (2 of 18)                                                                            |
| `pnpm typecheck` / `lint` / `format:check`            | exit 0                                                                                                                                       |
| `pnpm test`                                           | backend 1225, frontend 168, api-playground 14, shared 14, docs 26; exit 0                                                                    |
| `test:pg` with Redis                                  | 68 passed in 9 files (9 new in `one-time-token-race.pg.test.ts`, 1 in `session-revocation-http.pg.test.ts`)                                  |
| `test:pg` with Redis unreachable                      | 51 passed, 17 skipped                                                                                                                        |
| `test:redis`                                          | 61 passed                                                                                                                                    |
| `docs:build && docs:verify`                           | passed                                                                                                                                       |
| `test:e2e:security`                                   | not run: it covers login and CSRF, not the reset or verification links                                                                       |
| Frontend e2e (`test:e2e`)                             | not run: no UI touched                                                                                                                       |

## Notes for Next Session

1. Merge the feature PR, then a PR flipping feat-060 to `done`
2. Next: feat-062 (WS admin revocation) or feat-063 (resource limits); feat-069 (regression coverage) depends on feat-059, feat-060 and feat-066
