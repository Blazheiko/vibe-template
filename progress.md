# Progress: feat-099 Login Timing Equalization

Branch: `fix/feat-099-login-timing`. Source: security review finding 2 (medium): login answer time reveals whether an email/phone is registered. Start PR #330 (merge 203661b).

## State

- Steps 0–5 done; PR open. Next: green CI → merge → «Mark feat-099 done» PR.

## Fix

- New [`dummy-password-hash.ts`](packages/backend/src/app/services/auth/dummy-password-hash.ts): `getDummyPasswordHash()` hashes a random password with metautil `hashPassword` on first use and memoizes the promise (reset on failure). `validatePassword` reads the scrypt parameters from the hash, so the dummy costs exactly what a real hash costs.
- `login` in [`auth-service.ts`](packages/backend/src/app/services/auth/auth-service.ts) always calls `validatePassword(password, storedHash ?? dummy)` and fails when the user is missing, the stored hash is null/empty, or the check is false: a pass against the dummy hash never signs in.
- Out of scope, candidate for a new feature: `startPhonePasswordReset` (`password-reset-service.ts`) awaits SMS delivery only for a registered phone without an email; the blind path only stores a challenge, so its answer time may reveal the number. The email reset is fine (mail sent in the background).

## Files modified

- `packages/backend/src/app/services/auth/dummy-password-hash.ts` (+spec, new), `auth-service.ts`, `auth-service.regression.spec.ts` (the test that pinned «validatePassword not called» replaced), `auth-phone-foundation.spec.ts`.
- `documentation/backend/auth.md` (login: unknown identifier and OAuth-only answer in the same time).

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 2132 (+13) / frontend 400 / api-playground 62 / shared 25 / documentation 26.
- New tests: unknown email, unknown phone, OAuth-only (null) and empty hash each call `validatePassword` once with the dummy hash and answer `401 Invalid email or password`; a dummy check that resolves `true` still does not sign in; repeated misses hash the dummy once; the dummy hash has the same scrypt parameters as a real one (real metautil), matches no ordinary password, is memoized and retried after a failed hash.
- Mutation check: dropping `passwordHash === undefined` from the failure condition fails 2 tests (OAuth-only and empty hash sign in on a passing dummy check).
- `pnpm docs:build && pnpm docs:verify` clean.
- Manual on `dist` (local PostgreSQL + Redis, port 3099, per-request `X-Forwarded-For` with `TRUST_PROXY` and raised login limits so throttles do not interfere), 20 requests per case, wrong password, median:

    | Case                             | before (main) | after   |
    | -------------------------------- | ------------- | ------- |
    | wrong password on a real account | 75.0 ms       | 75.2 ms |
    | unknown email                    | 2.6 ms        | 74.9 ms |
    | OAuth-only account               | 1.9 ms        | 76.3 ms |

    All answers `401 Invalid email or password`. Golden path: on a fresh account wrong password 401, right password 200 with the user. Test users removed.
