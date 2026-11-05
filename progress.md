# feat-123 — Session and Auth Gaps (G3)

Plan: `docs/plan/code-review-2026-11-03-plan.md`, «Четверте рев'ю 2026-11-04», G3; start #402. Branch: `fix/feat-123-session-auth-gaps`.

## Current State

Implemented; PR open.

- **L5:**
    - `Session.isStored()` (types, `RequestSession`, the WS session, the default context; a cookie-held session → false) uses the store's existing `sessionExists` (EXISTS, no TTL slide).
    - `authService.startEmailLink`, `startPhoneLink` and `confirmPhoneLink` and `oauthService.resendFirstEmailLink` take an optional `sessionStored` guard. It is asked right before the mail, the SMS or the confirmation (after the password check), and answers `401 session_revoked` when the record is gone. The controllers pass `() => context.session.isStored()`.
    - It is a `Result`, not a thrown `SessionGoneError` as the plan wrote, following ADR 0004 for expected outcomes.
- **F6-low:** the OAuth callback compares the state with `safeEqual` before consuming it. A mismatch → `OAuth state mismatch` redirect, with nothing consumed.
- **R06b:** a spent password re-check / change-password budget answers `429 rate_limited`. The shared `change_password_user` budget is kept instead of a separate `reauthUser` policy, deliberately: a second counter would double the guesses through a stolen session. This is recorded in `auth.md`.
- Docs: `auth.md` (single logout and the protected operations; the password budget), `oauth.md` (state compared first).

## Files Modified

- `vendor/types/types.d.ts`, `vendor/utils/context/http-context.ts`, `vendor/utils/session/request-session.ts`, `session-handler.ts`
- `app/services/auth/auth-service.ts`, `oauth-service.ts`; `app/controllers/http/auth/auth-controller.ts`, `oauth-controller.ts` + spec
- Tests: `auth-service.throttle-contract.spec.ts` (429), `auth-phone-foundation.spec.ts`, `reauth-and-reset-links.pg.test.ts`, `session-store.redis.test.ts`
- Docs as above.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `git diff --check` clean.
- `pnpm test`: backend 2375, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` with Redis: 28 files / 251 passed. `test:redis`: 11 files / 115 passed.
    - The first full run had 4 timing failures: readiness probe, support history, the stale SETEX and the lock's maximum lifetime. The machine's load average was about 75 then.
    - Each passed on its own (Redis 3×, PG 2×), and the full suites passed on a second run. None touches this change.
- New tests:
    - real Redis: `isStored()` is true, then false after the record is deleted;
    - PG:
        - link-email/start with the guard false → 401, no mail;
        - the guard is asked once, after the password check;
        - the 11th re-check → `RateLimited`;
    - unit:
        - link-phone/start with the guard false → 401, no SMS, no challenge;
        - a forged callback state → nothing consumed, no `handleCallback`;
        - the contract cases expect 429.
- Mutation check: without the guard, 3 cases fail; without the state comparison, 1; with 400 back, 2.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next by the plan: G4 (WebSocket: `ws.send` results in broadcast, R04 lows).
