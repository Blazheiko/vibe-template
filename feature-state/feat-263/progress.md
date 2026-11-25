# feat-263 progress: Branded Ids Foundation And Auth

Plan: `docs/plan/branded-types-plan.md` (rev. 5), tasks T10–T20 in `docs/plan/branded-types-tasks.md` (v2.1).
Status PR: #842 (`in_progress`, merged). Branch: `feat/branded-ids-auth`.

## State

- T10: started from `main` after feat-262 (#838, #841, done #840).
- T11: `docs/adr/0007-branded-types.md`.
- T12: `database/ids.ts`, `app/domain/ids.ts` (`parseUserId`, `parseOAuthAccountId`, `asUserId` for trusted text,
  `toEntityId`); `$type<UserId>()` on `users.id`, `$type<OAuthAccountId>()` on `oauth_accounts.id`. Drizzle
  `1.0.0-rc.5`: select, insert, `returning`, `eq`, `inArray` and `defineRelations` compile with branded columns while
  the PKs of other domains stay `bigint` (checked first on a scratch branch: 134 errors, all `eq(column, bigint)`, none
  in `relations.ts`). `deleteByIdForUser(id, userId)` → `deleteForUser(userId, id)`.
- T13: brands `UserOnlineId`, `OneTimeTokenRowId` (4 token tables), `TotpFactorId`, `MfaRecoveryCodeId`, `PasskeyId`,
  `SmsChallengeId` (nanoid string) with constructors; `findSmsChallenge(raw)` for an id a client sends back.
- T14: every user id parameter in the app is `UserId`; webauthn `rename` / `deleteOne` and totp `consumeStep` take
  `(userId, id, …)`; type tests in `app/shared-brands.spec.ts` (swapped ids, unbranded values, constructors).
- T15: vendor `SessionData` unchanged; `RequestSession.userId()` answers a stored id that is not a row id as no user
  (logged once); `requireUserId` → `parseUserId`; `BigInt(sessionText)` replaced by `asUserId` (permission-guard,
  ws-coordinator, ws-role-sync, ws support controller, audit-actor, auth-service, mfa-sign-in, session-list, main,
  admin online users); `checkSessionToken` uses `parseUserId` (a bad id was 503 `unavailable` through the throw of
  `asUserId`, now `mismatch`); session, login and WS writes use `toEntityId`. Redis test: a stored session with
  `abc`, `0`, `007`, 2^63, `' 42'` does not authenticate (`logout-all.redis.test.ts`).
- T16: `scripts/eslint-rules/no-brand-cast.mjs` (type-aware: the cast type and its union members carry `' brand'`),
  wired in `eslint.config.ts` for backend and shared sources except constructor modules and tests; RuleTester suite
  (12 cases) runs in `pnpm test`. No violation in existing code; a probe cast in `app/services` is reported.
- T17: transformers (`user`, `audit-event`, push `userId`) use `toEntityId`.
- T18: tutorial `adding-a-feature` (uk + en), skill `backend-feature`, docs `database`, `repositories`, `transformers`
  (uk + en).

## Deviations from the task list

- Every user id column of every table (`user_id` FKs of notifications, push, support, AI; audit actor/target) is
  `UserId` already in this feature, not in feat-264: once `users.id` and the user id parameters are branded, a
  `bigint` user id would fail at each call into the auth services. feat-264 brands the PKs of its own tables.
- Test files use `uid(n)` from `test-support/ids.ts` for fixture user ids, and casts for other brands (tests are
  exempt from `no-brand-cast`).
- PG and Redis suites run in CI only (the local services belong to another project).

## Evidence of Completion

- `make check`: exit 0 (backend 3856, frontend 1029, shared 151, api-playground 115, landing 103, documentation 26,
  eslint rules 12 tests passed; `check-bundle-graph: 762 modules, no schema and no validator library`).
- `pnpm --filter backend db:generate`: "No schema changes, nothing to migrate" (drizzle-kit loads the schema with
  the relative brand import).
- `pnpm docs:build && pnpm docs:verify`: exit 0, "verify-dist: all checks passed".
- `make test-pg` / `make test-redis`: CI jobs of the implementation PR (links added after the run).
- Manual golden path: not run against a live app (no local database of this project); sign-in, unlink and the WS
  handshake are covered by the HTTP PG and Redis suites in CI.

## Notes for Next Session

After the merge: "Mark feat-263 done". Next: feat-264 (T21) — PK brands for notifications, push, support, AI, admin,
audit, Р11 order in the push repositories, removal of `parseEntityId` (T25).
