# feat-120 — OAuth State Single Consumption (F6)

Plan: `docs/plan/code-review-2026-11-03-plan.md`, «Третє рев'ю 2026-11-04 (576323e)», F6 (high), after feat-119; start #393. Branch: `fix/feat-120-oauth-state-consume`.

## Current State

Implemented; PR open.

- New `consumeSessionData(sessionId, userToken, expected, keys)` in `redis-session-storage.ts`:
    - it removes `keys` only while every `expected` value is still stored, with the compare-and-set of feat-111;
    - a retry after a conflict checks the values again on the fresh record;
    - it returns `consumed` / `mismatch` / `gone`.
    - `Session.consumeSessionData` (types) is wired in `RequestSession` (a cookie-held session → `mismatch`), the WS session and the default context.
- The OAuth callback consumes `{ oauthState: storedState }` together with the verifier before `handleCallback`:
    - `gone` → `session_revoked`;
    - `mismatch` → `OAuth state was already used or replaced`, and a newer state stays;
    - only `consumed` goes on.
- Docs: `oauth.md` (the three outcomes).

## Files Modified

- `packages/backend/src/vendor/utils/session/redis-session-storage.ts`, `request-session.ts`, `session-handler.ts`, `vendor/utils/context/http-context.ts`, `vendor/types/types.d.ts`
- `packages/backend/src/app/controllers/http/auth/oauth-controller.ts` + spec
- `packages/backend/src/vendor/utils/session/session-store.redis.test.ts`
- `documentation/backend/oauth.md`

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `git diff --check` clean.
- `pnpm test`: backend 2354, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` with Redis: 28 files / 244 passed. `test:redis`: 11 files / 114 passed.
- Real Redis (`session-store.redis.test.ts`):
    - two callbacks with snapshot A, both restored before either consumes → `handleCallback` once, one success, one `already used or replaced`;
    - a late callback A after a new start wrote B → no sign-in, and the record still holds `oauthState: B`, `oauthCodeVerifier: vB`;
    - 10 concurrent `consumeSessionData` of one value → 1 `consumed`, 9 `mismatch`.
- Spec: the consume is called with `{ oauthState: 'state-1' }` before `handleCallback`, and `mismatch` → no sign-in.
- Mutation check:
    - `main`'s controller (generic `updateSessionData`, the reviewed code) fails both scenarios and 4 spec cases;
    - without the expected-value check in the store, both scenarios and the 10-consumer race fail.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
