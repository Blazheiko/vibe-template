# feat-265 progress: Branded Secret States

Plan: `docs/plan/branded-types-plan.md` (rev. 5), tasks T27–T32 in `docs/plan/branded-types-tasks.md` (v2.1).
Status PR: #850 (`in_progress`). Branch: `feat/branded-secrets`.

## State

- `app/domain/secrets.ts` (no `#` imports): `RawToken` / `TokenHash`, `SessionBindingHash`, `OtpCode` / `OtpHash`,
  `RawRecoveryCode` / `NormalizedRecoveryCode` / `RecoveryCodeHash`, `MfaBindValue` / `MfaBinding`, `SessionToken`,
  and the MFA ids `MfaTicketId`, `MfaReservationId`, `MfaCompletionId`, `MfaAttemptId`, with their constructors.
  Hashes that need a server key (OTP, recovery codes, `mfa_bind`) take the key as an argument; the services pass it
  from the config (`otpHashKey()`, `appConfig.key`), so no service casts.
- T28: `hashToken(RawToken): TokenHash`, `newRawToken`, `findUsableToken(…, RawToken)`,
  `ITokenRepository.findByTokenHash(TokenHash)`; `$type<TokenHash>()` on the four `token_hash` columns,
  `$type<SessionBindingHash>()` on `oauth_link_verifications.session_binding_hash`.
- T29: recovery codes `RawRecoveryCode → normalizeRecoveryCode → NormalizedRecoveryCode → hashRecoveryCode →
RecoveryCodeHash` (`mfa_recovery_codes.code_hash`); OTP `hashOtpVerificationCode(OtpCode): OtpHash`,
  `verifyOtpVerificationCode(OtpCode, OtpHash)` (`sms_auth_challenges.code_hash`); the pending placeholder is
  `PENDING_OTP_HASH`.
- T30: `users.session_token` is `$type<SessionToken>().$defaultFn(newSessionToken)` (a relative runtime import in
  `schema.ts`; `db:generate` loads it); every rotation uses `newSessionToken()`; the presented / expected / previous
  session token parameters are `SessionToken`, branded at the boundary by `presentedSessionTokenOf` (HTTP) and in
  `ws-coordinator` (WS); `isSessionStored(sessionId, userToken: SessionToken)`. `mfaBinding(MfaBindValue): MfaBinding`
  (key from the config), the MFA ids branded where they are made or read (`newMfaReservationId`,
  `newMfaCompletionId`, the ticket cookie, the browser's `attemptId`).
- Type tests: `app/domain/secrets.spec.ts` (raw token vs hash, OTP code vs hash, recovery code before
  normalization, `mfa_bind` value vs binding, plain text).

## Deviations from the task list

- `SessionId` is not branded: session ids are vendor-owned text in ~30 app parameters. The pair that could be swapped,
  `(sessionId, userToken)`, cannot be any more since `userToken` is a `SessionToken`.
- `checkSessionToken(userId, userToken)` keeps `string` parameters: it is the checker the vendor session layer calls
  (`registerSessionTokenChecker`), and the vendor types stay unbranded (Р13).
- Instead of `asMfaBinding(hmac)` (task list T30), `mfaBindingOf(key, value)` in `app/domain/secrets.ts` computes the
  binding from a key argument: no casting constructor is needed outside the domain.
- The MFA ticket JSON in Redis keeps its fields as text; ids are branded when read (`mfaCompletionIdOf`).
- `mfa-ticket.redis.test.ts` sees the store through a test-only type that widens its branded string parameters.

## Evidence of Completion

- `make check`: exit 0 (backend 3897, frontend 1029, landing 103, eslint rules 12; bundle graph without ArkType).
- `pnpm --filter backend db:generate`: "No schema changes, nothing to migrate" (with the runtime import of
  `newSessionToken`).
- `make test-pg` / `make test-redis`: CI jobs of the implementation PR (links added after the run).
- Manual golden path: not run against a live app (no local database of this project); password reset, e-mail
  verification, TOTP and recovery-code sign-in are covered by the HTTP PG and Redis suites in CI.

## Notes for Next Session

After the merge: "Mark feat-265 done". Next: feat-266 (T33, `NormalizedEmail`).
