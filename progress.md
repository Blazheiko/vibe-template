# feat-176 — Auth Recovery and OAuth Contracts (C4.5)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (C7, C4, C8, C5b, C6), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (C4.5). Depends on feat-175.

## State

Done, waiting for review and merge.

## What changed

- Ten routes on contracts:
    - `authContracts` gets `forgot-password`, `reset-phone/start`, `reset-phone/complete`,
      `reset-password`, `link-phone/start`, `link-phone/confirm`, `link-email/start`;
    - a new `oauthContracts` group (`shared/contracts/oauth.ts`) has `providers`, `link/confirm`
      and `email/resend`. That last route reads no body, so its contract has none.
- The OAuth redirect and callback answer with a redirect and wait for feat-177.
- The routes keep their settings: `auth_guard` on linking and `email/resend`, and the rate
  limits of `forgot-password` and `reset-password`.
- Frontend: ten `authApi` wrappers call `callApi` with the same options as before:
    - `csrfRecovery: 'public'` for recovery and `oauth/link/confirm`;
    - nothing for linking and `email/resend`.
- `DIRECT_HTTP_CALLS` goes 11 → 1. The one left is `DELETE avatar`, which moves with the
  multipart avatar upload in feat-177.
- Docs (both locales): `backend/routing.md`, the list of routes on contracts.

## Evidence of Completion

- `make check`: backend 2656, frontend 500, shared 30, playground 111; bundle graph: no schema.
- `pnpm --filter backend test:pg` (with `REDIS_TEST_URL`): 295 passed.
- `pnpm --filter frontend test:e2e`: 92 passed (forgot-password, OAuth link, login, register).
- `test:e2e:live`: 13 passed (a password reset by mail, sessions).
- `test:e2e:security`: 7 passed.
- `pnpm docs:build && pnpm docs:verify`: passed.
