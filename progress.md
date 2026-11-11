# feat-175 — Auth Session Routes Contracts (C4.4)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (C7, C4, C8, C5b, C6), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (C4.4). Depends on feat-174.

## State

Done, waiting for review and merge.

## What changed

- Nine `auth` routes on contracts: `register/email`, `register/phone/start`, `confirm`,
  `complete-profile`, `logout`, `logout-all`, `change-password`, `verify-email`,
  `resend-verification-email`. They are in `authContracts` (with `login`) and in
  `app/routes/contract-schemas/auth.ts`.
- Each route keeps its server settings: `auth_guard`, and the rate limits of `verify-email`
  and `resend-verification-email`.
- Frontend: nine `authApi` wrappers call `callApi` with the same transport options as before:
    - `csrfRecovery: 'public'` for registration and `verify-email`;
    - `sessionAfter: 'anonymous'` for `logout` and `logout-all`;
    - no option for `change-password` and `resend-verification-email`.
- `DIRECT_HTTP_CALLS` goes 20 → 11.
- Docs (both locales): `backend/routing.md`, the list of routes on contracts.

## Evidence of Completion

- `make check`: backend 2656, frontend 500, shared 30, playground 111; bundle graph: no schema.
- `pnpm --filter backend test:pg` (with `REDIS_TEST_URL`): 295 passed.
- `pnpm --filter frontend test:e2e`:
    - three full runs: 91 + 1 failed, then 92, then 92;
    - the failure was the login double-click test (`login.spec.ts:153`), which sent two requests;
    - that test passed 8 of 8 alone, login is not changed here, so it is recorded as flaky.
- `test:e2e:live`: 13 passed (registration, verification, logout, change of password, sessions).
- `test:e2e:security` (with `PGSQL_DB_NAME=vibe_e2e_live`, its own build): 7 passed
  (cold login, logout and login again, a stale token: the CSRF paths of these calls).
- `pnpm docs:build && pnpm docs:verify`: passed.
