# feat-271 · Branded Types Coverage Cleanup

Branch: `chore/branded-types-coverage`. Status: implementation done, PR open.

## Changes

**Ids (Р11, Р13).** `UserId` / `TotpFactorId` / `OAuthAccountId` / `NotificationId` / `PushSubscriptionId` replace the last bare `bigint` ids (email-verification owner, `totpService.verify` factorId, `signInCapability.removeOAuthLinkId`, `notificationOpenPath` and `NotificationDelivery.id`, avatar `serializeUser`, the push log map). Owner first in `getPushSubscriptionStatistics(userId, subscriptionId)` and `oauthAccountRepository.findLinkForUser(userId, provider, providerUserId, tx)`. `parseUserId` instead of a throwing `asUserId`: `permission-guard` parses once (null → 403), `ws-coordinator` once (null → no registration), the MFA ticket is read as gone when its `userId` / `plan.userId` is not a row id (Redis test), `sessionListService.revoke` takes a `UserId`, `underUserRowLock(UserId)` plus `sessionDeletionLock(text)` for the session layer (an invalid id deletes without the lock), and `request-session` passes `this.userId()`.

**Secrets / email.** `SessionToken` kept in `userRepository.findSessionToken(s…)`, `userRoleService.findAccess`, `startSecondStepIfRequired`, oauth-service (`ClaimedLink`, `finishSignIn`, second step), auth-service rotation result and session-list result. `normalizeRecoveryCode` / `recoveryCodes.consume` take `RawRecoveryCode`. `addressMatches` and `enforceEmailLinkThrottles` take `NormalizedEmail` (addressMatches still normalizes both sides: a stored token target may predate normalization, pinned by the password-reset contract test). New `app/secret-brands.spec.ts`: SessionBindingHash vs TokenHash, `verifyOtpVerificationCode` order, `isSessionStored` order, MFA id swaps, `consumeStep` owner first.

**Time (Р7, T38, T40).** `totpStepAt` / `matchTotpStep` take `UnixMs` (via `unixSecondsOf`); `session-handler` anon age via `unixSecondsOf(nowUnixMs())`; `now?: number` → `UnixMs` across the auth/MFA services (passkey, totp, step-up, require-proof, privileged-actor, mfa-reset, sign-in-methods, role-assignment, mfa-sign-in, staff-policy) and the admin WS channel; positional `now: number` → `nowMs: UnixMs`; `now` → `nowMs` in `mfaTicketStore.reserve` / `capture`, `splitSessionChallenges`, scheduler `SuccessRecord` / `FailureRecord`; `* 1000` replaced by `addMs` / `toMs` with `Seconds`-branded config (`recoveryWindowSeconds`, `totpEnrollmentTtlSeconds`, `challengeTtlSeconds`). Compile-time tests for the units and operations in `app/time-brands.spec.ts`.

**Shared / frontend (T44).** `IsoDateTime` for `totp.createdAt`, push `created_at` / `updated_at` / `statistics.lastUsed`, auth user `created_at?` / `updated_at?`; `EntityId` for admin `user.id` (role, MFA reset) and support reindex `failed`. `QueryWireValue` unwraps brands inside lists, checked on a real ArkType schema (optional, nullable, list, parsed number). Frontend `pushSubscriptionId` / notifications `next` refs are `EntityId | null`; `no-brand-cast` covers `.mts` / `.tsx`; a `<template>` takes no `as` cast (`vue/no-restricted-syntax`, no template had one).

**Static checks.** `no-brand-cast` catches casts to containers of a brand (array, tuple, Promise, Set, Map, Record) and to a type parameter constrained to one (`getBaseConstraintOfType`); TypeFlags come from the installed compiler (their numbers changed in TS 6). 7 new invalid and 4 valid RuleTester cases.

Docs: `shared/index.md`, `backend/adding-a-feature.md` (both locales).

Not done (left as is, with reason): `ws-message-budget` / rate-limit `now: number` in vendor (outside the app services the review named for T40); `config/session.ts` `toSecondsFloor` (whole-second config, no effect); Low items of the review.

## Evidence of Completion

- `make check`: exit 0 (backend 3925, frontend 1029, landing 103, api-playground 115, rule tests 31; one pre-existing frontend lint warning).
- `pnpm docs:build && pnpm docs:verify`: all checks passed.
- `QueryWireValue` list check fails (1 TS error) without the fix.
- Probes: a `.mts` cast and a `<script>` cast are reported by `no-brand-cast`, a template cast by `vue/no-restricted-syntax`.
- Baseline `./init.sh` failed on 5 timeouts (auth-service contract, throttle-contract, oauth-service specs) at load average ~160; the 3 files passed alone (289 tests) and in the final `make check`.
- PG / Redis suites: not run locally (Docker down after a reboot); CI `test-pg` and `test-redis` of the PR.
