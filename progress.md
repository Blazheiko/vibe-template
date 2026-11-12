# Progress: feat-189 Password Bounds From One Schema

## Current state

Done, in review. Code review: `shared/limits` declared `PASSWORD_MIN_LENGTH`/`PASSWORD_MAX_LENGTH`, but eight auth schemas repeated `'string >= 8 & string <= 32'` in eleven fields and the contract test covered four schemas.

- `packages/shared/src/schemas/auth/password.ts` (new): `PasswordSchema = type('string').atLeastLength(PASSWORD_MIN_LENGTH).atMostLength(PASSWORD_MAX_LENGTH)`, exported from `shared/schemas`.
- Uses it: `login`, `register-email`, `register-phone-complete`, `change-password` (both fields), `reset-password` (both), `reset-phone-complete` (both), `link-email-start`, `link-phone-start`.
- `verify-email`: keeps min 1 on purpose (a short password is a wrong password, answered `invalid_password`, not a validation error), max now from `PASSWORD_MAX_LENGTH`; the stale "as in login" comment is replaced.
- `packages/shared/test/contracts.test.js`: checks `PasswordSchema` at the bounds and walks every exported schema: each field whose name contains `password` must equal `PasswordSchema` (verify-email checked separately).
- Behaviour unchanged: `PasswordSchema` `.equals` the old literal; the route serialization shows the same `string <= 32 & >= 8`.
- Docs (uk and en) `guide/how-backend-works`: the login schema example was stale (Legacy variant removed in feat-093), now matches `login.ts` and names `PasswordSchema`.
- Not changed: broadcast guards in `frontend/src/utils/ws-payload-guards.ts` stay hand-written (feat-049 §4.5, ArkType out of the bundle); their parity test is complete by `BroadcastEventName`.

## Evidence of Completion

- Contract test RED check: with `link-email-start` reverted to its own literal (min 6) the test failed on `LinkEmailStartInputSchema.currentPassword is PasswordSchema`; restored.
- `make check`: passing (backend 2690, frontend 532, api-playground 115, shared 33, documentation 26).
- `pnpm --filter frontend test:e2e`: 92 passed.
- `pnpm docs:build && pnpm docs:verify`: passing.
- Manual: `type('string >= 8 & string <= 32').equals(PasswordSchema)` is `true`; `LoginInputSchema` with a 5-character password answers `password must be at least length 8 (was 5)`.

## Notes for Next Session

Nothing open.
