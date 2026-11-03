# Progress: feat-099 Login Timing Equalization

Branch: `fix/feat-099-login-timing`. Source: security review finding 2 (medium): login answer time reveals whether an email/phone is registered. Start PR #330 (merge 203661b).

## State

- Step 0 done: feat-099 `in_progress` on `main`, branch created, `./init.sh` green (baseline: backend 2119 / frontend 400 / api-playground 62 / shared 25 / documentation 26).
- Next: step 1 (dummy hash module) and step 2 (`login` always runs scrypt).

## Problem

`login` in `packages/backend/src/app/services/auth/auth-service.ts` returns `invalidCredentials()` without scrypt when the user is not found and when the account has no password (OAuth-only). A wrong password on a real account costs one scrypt call (N=32768), so the answer time tells whether the identifier is registered. Registration already hashes before the lookup for the same reason.

## Plan

1. `src/app/services/auth/dummy-password-hash.ts`: memoized `getDummyPasswordHash()` made by metautil `hashPassword` (same scrypt parameters as real hashes, since `validatePassword` reads them from the hash); reset the memo on failure.
2. `login`: always `validatePassword(password, storedHash ?? dummy)`; fail when the user is missing, the stored hash is empty, or the check is false (a dummy "match" never succeeds).
3. Tests: invert `auth-service.regression.spec.ts` "validatePassword not called"; unknown email/phone and OAuth-only call `validatePassword` once and answer the same; `validatePassword` resolving true for an unknown user still fails; unit test for the memoized dummy hash.
4. Check `password-reset-service.ts` lookups for the same leak; a separate feature if one is found.
5. Docs: `documentation/backend/auth.md` login section; `pnpm docs:build && pnpm docs:verify`.
6. DoD: typecheck/lint/test, manual timing comparison on `dist` (median of 20 requests: wrong password vs unknown email vs OAuth-only).

## Files modified

- `progress.md` (this file).

## Evidence of Completion

- Pending.
