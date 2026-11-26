# feat-266 progress: Normalized Email Brand

Plan: `docs/plan/branded-types-plan.md` (rev. 5), tasks T33–T36 in `docs/plan/branded-types-tasks.md` (v2.1).
Status PR: #854 (`in_progress`). Branch: `feat/normalized-email`.

## State

- T34: `app/domain/email.ts` — `NormalizedEmail` and its only constructor `normalizeEmail` (trim + lower case);
  `services/auth/auth-normalize.ts` re-exports it. `$type<NormalizedEmail>()` on `users.email`,
  `oauth_accounts.provider_email`, `oauth_link_verifications.provider_email` and the three `target_email` columns
  (`email_link_verifications`, `password_reset_tokens`, `oauth_link_verifications`): every write path checked by the
  compiler takes a normalized address (`OAuthIdentity.providerEmail` is normalized once where the provider's profile is
  read; the MFA ticket keeps the identity as JSON, so it is normalized again when the link is created; the seed
  normalizes its users). `findByEmail` and `emailExistsForOtherUser` take a `NormalizedEmail`; `LoginKey`, the
  registration input, `sendLinkVerificationEmail` and the first OAuth link mail too. SQL keeps `LOWER()` as a guard.
- T35: `shared/schemas/auth/email.ts` `EmailInputSchema` (`string.email & string <= 255`) is used by the register,
  forgot-password and link-email-start schemas; the unnormalized `EmailSchema` / `Email` brand is removed from
  `brands/primitives.ts`; contracts test for the schema; docs `shared/index.md` (uk + en).
- Type test `app/domain/email.spec.ts` (`findByEmail('Jane@…')` does not compile).

## Evidence of Completion

- `make check`: exit 0 (backend 3897 + 2, frontend 1029, shared 152, landing 103, eslint rules 12; bundle graph
  without ArkType).
- `pnpm --filter backend db:generate`: "No schema changes, nothing to migrate".
- `pnpm docs:build && pnpm docs:verify`: exit 0.
- `make test-pg` / `make test-redis`: CI jobs of the implementation PR (links added after the run).
- Manual golden path: not run against a live app (no local database of this project); registration, login by
  e-mail and the OAuth link are covered by the HTTP PG suites in CI.

## Notes for Next Session

After the merge: "Mark feat-266 done". Next: feat-267 (T37, time units).
