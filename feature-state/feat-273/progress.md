# feat-273 · Branded Types Final Gaps

Branch: `fix/branded-types-final-gaps`. Status: implementation done, PR open. The registry PR (#888) and the status PRs wait for the owner's go-ahead to merge.

## Changes

1. **OTP hash suffix (regression of feat-272).** `otpCodeMatches` refuses an expected hash that is not exactly 64 lowercase hex characters before decoding; the right hash with `zz`, one extra hex digit or a newline after it is no match (tests fail without the fix), and the comparison stays `timingSafeEqual`.
2. **No-deadline state.** `NO_STAFF_DEADLINE = 'none'` and `StaffDeadline = UnixMs | 'none'` replace `unixMs(Infinity)`; `admin-channel-subscribers` orders and expires through `noLaterThan` / `hasCome`, the timer returns for `'none'`, the vendor `staffAccessDeadline` stays absent for never. Type tests: arithmetic on a deadline needs the narrowing.
3. **closeUserConnections(UserId)**: callers pass the id (no more `toEntityId` / `String`); `SessionId` in `ws-connection-registry` (`StoredConnection`, `ConnectionMeta`, `ListedConnection`, `ConnectingEntry`, `revokeConnecting`, `hasSessionConnection`); the coordinator brands the session id once.
4. **newSmsChallengeId()** in `app/domain/ids.ts` is the default of `sms_auth_challenges.id`; `schema.ts` no longer imports `nanoid` (`db:generate`: no schema changes). `database.md` (both locales) lists the runtime imports of the schema.
5. **Time units.** `webauthn-ceremony` timeouts via `toMs`; `shared/mfa/session-auth.ts` (`isFresh` with `UnixMs` + `Seconds`, `latestMark` → `UnixMs`, `isActiveRecovery`) and `ProofWindows` in `Seconds`, `mfaConfig.reauthWindowSeconds` / `oauthRecentSeconds` branded; `request-session` cookie `maxAge` is `Seconds` (`setCookie`, `setMfaTicketCookie`, `issueStoredCookie`) with `addMs(nowUnixMs(), toMs(maxAge))`; the second step clears the ticket cookie with a named `seconds(0)`. Type tests in `time-brands.spec.ts`.

## Evidence of Completion

- `make check`: exit 0 (backend 3937, frontend 1029, landing 103, api-playground 115, rule tests 30).
- Affected Redis suites (`REDIS_TEST_URL=redis://127.0.0.1:6379/15`; session, communication, auth, websocket, shared; `redis-main.redis.test.ts` left out, it pauses the server): 9 files, 116 passed.
- `pnpm docs:build && pnpm docs:verify`: passed. `db:generate`: no schema changes.
- New regression tests fail without the fixes (OTP hash suffix).
- PG suite: CI `test-pg`.

## Review of #889 (REQUEST CHANGES, test-pg)

- Four PG tests (`mfa-reset.pg.test.ts`, `privileged-session-lock-timeout.pg.test.ts`) still expected `String(id)` from `closeUserConnections`; they now expect the `UserId`. The unit specs had been updated, the PG suites are not run locally (no Postgres of this project), so CI caught them.
- `UserConnection.staffAccessDeadline` is `UnixMs` (always finite, absent while the rule is off); its comment no longer mentions Infinity.
- The timeout while deleting a test user in the same CI run: checked again on the next run (see below).
