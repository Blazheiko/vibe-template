# feat-256: MFA Review Fixes 7

## Status

Implemented, ready for review. Branch `fix/mfa-review-7`. Plan:
`docs/plan/mfa-review-fixes-7-plan.md` (items 1, 3, 4, 5, 6; items 2 and 7 are feat-257).

## Scope

1. A late failure never deletes a captured ticket: `SETTLE_LUA` deletes at the limit only while
   `open`; `REOPEN_LUA` deletes a ticket brought to the limit meanwhile (`reopened | deleted |
no`) and every rollback path answers `mfa_ticket_invalid` with the ticket cookie cleared (the
   known rollback answers instead of throwing, so the cookie reaches the browser). The revoked
   branch deletes only an `open` ticket, atomically (`deleteIfOpen`).
2. `isProofAdmissible` (shared/mfa) re-checks, under the row lock, the proof the TOTP setup or
   the passkey options kept, against the current factors; a refused passkey options pair is
   removed for its `enrollmentId` only. The TOTP form restarts the setup on a final refusal.
3. `PasskeyList` keeps a registration until its final answer and resends the same request after
   an unknown outcome (0, 5xx, 408, 429); the TOTP form keeps setup and code then.
4. `useSessionLifecycle.finishRecovery`: `left` only after a confirmed end (answer, or main/init
   401 after an unknown outcome); `kept` / `unknown` stay signed in with a message. The plain
   logout keeps its behaviour (decision of 2026-11-24).
5. A wrong proof counted once per logical attempt (`attemptId`, optional, `failedAttempts`); a
   Redis failure of the count is a 503. The passkey challenge is read, and spent by the count or
   the capture in the same Lua step, only while it is still the one checked.

## Deviations from the plan

- Item 3: when the kept proof is inadmissible but the session could give a proof now, the answer
  is 400 `enrollment_not_found` ("start again"), so the audited proof stays the kept one; otherwise
  the 403 the matrix answers now.
- Item 3: the TOTP setup object is not removed from the session on a refusal
  (`consumeSessionData` compares strings only); it fails the same way again and a new setup
  replaces it.
- Item 6: a passkey answer whose attempt rolled back before the capture (a lapsed reservation)
  no longer needs a new ceremony: the challenge was not spent, like a TOTP step.
  `mfa-sign-in-http.pg.test.ts` was updated accordingly.

## Evidence of Completion

- `make check` green: backend 3702, frontend 1013, shared 149, landing 103, api-playground 115,
  documentation 26.
- `pnpm --filter backend test:pg` (PG_TEST_URL set): 72 files, 711 passed, 0 skipped.
- `pnpm --filter backend test:redis` (REDIS_TEST_URL set): 20 files, 205 passed.
- `pnpm --filter frontend test:e2e`: 133 passed (mock `mfa.spec.ts` re-run after a lint fix: 6).
- `pnpm docs:build && pnpm docs:verify`: passed.
- CI on the branch: see the PR.

## Manual verification

Golden paths covered by the HTTP PG suites against real PostgreSQL and Redis
(`mfa-sign-in-http.pg.test.ts`: a lost count answer, a count before applying, a known rollback at
the limit with the cookie cleared, passkey count/capture) and the mock e2e of the MFA form;
`test:e2e:live` runs in CI (`e2e-live`).
