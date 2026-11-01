# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-074 - SMS Challenge Module (in progress, H5)
**Branch:** `refactor/sms-challenge`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase H5

## Status

### Done

- [x] `app/services/auth/sms-challenge.ts`: `findPendingChallenge` (the waiting challenge of a phone and flow; 429 `resend_cooldown_active` before the resend time), `openChallenge` (retire the waiting ones, store a new one with the placeholder hash or one given for a "blind" challenge, times from the configuration), `deliverChallenge` (send the code, record only its hash; **provider failure, a failed record and a challenge invalidated meanwhile each invalidate the new challenge**), `issueSmsChallenge` (= open + deliver), `verifySmsCode` (a wrong code costs a try, the try that spends the budget invalidates), `confirmChallenge` (`markConfirmed`, 400 when the challenge stopped being valid)
- [x] Used by the three flows: start of phone registration and phone linking (`authService`), start of phone password reset (`passwordResetService`, also its blind challenge for a number that is unknown or whose account has an e-mail, through `openChallenge`), and the verify and confirm steps of `confirmPhoneRegistration`, `confirmPhoneLink`, `completePhonePasswordReset`. Their public messages stay per flow and are passed in
- [x] **Net, untouched:** the G1 phone rows (`auth-service.contract.spec.ts`, `password-reset-service.contract.spec.ts`), the throttle tables, `auth-phone-foundation.spec.ts`: 707 service specs pass without a change
- [x] `sms-challenge.spec.ts` (19) pins the rollbacks and the budget on the module itself, as the plan asks. Mutations (the provider failure not invalidating, `>=` → `>` on the budget, no cooldown, no retiring of the old challenges) fail 4 / 5 / 7 / 3 specs
- [x] Docs: `backend/auth.md`

### Notes

- The pieces the three confirm flows do NOT share stay in the flows: the order of the checks (the link flow checks the owner and the session before validity, registration after), the 404 vs 400 of an unknown challenge, the "same session" rule of registration and linking, and what a confirmed challenge allows. A single `verifySmsChallenge` hiding those would have changed behaviour
- The metadata of the challenge is built by the caller and used for both the stored row and the `markIssued` call (they were two equal literals)

## Evidence of Completion

| Check                                      | Result                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| Service specs, unchanged                   | 707 passed                                                              |
| Mutations of the module                    | 4 / 5 / 7 / 3 failures                                                  |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                  |
| `pnpm test`                                | backend 1731 (+19), frontend 257, api-playground 29, shared 17, docs 26 |
| `test:pg`                                  | 84 passed, 64 skipped (no Redis here)                                   |
| `docs:build && docs:verify`                | passed                                                                  |

## Notes for Next Session

1. Merge this PR; then a PR flipping feat-074 to `done`: that ends phase H (H6, "small things", is optional and can go into any H or separately)
2. Next in the plan: phase I (feat-075, frontend and shared dedup); check its dependencies in `feature_list.json`
