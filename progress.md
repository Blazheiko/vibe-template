# Progress: feat-096 Credential Transaction Foundation

Branch: `fix/feat-096-credential-transactions`. Plan: [`docs/plan/oauth-pre-hijack-plan.md`](docs/plan/oauth-pre-hijack-plan.md), foundation part (етап 0, «feat-096»).

## Scope

- `runTokenTransaction`: one transaction owner for one-time tokens (lock user → check → consume with `clock_timestamp()` → apply → invalidate the rest by `user_id`, no `exceptId`). Replaces `consumeTokenAndApply`.
- `issueTokenLocked`: issuance under the same user lock (check → invalidate → insert in one transaction, mail after commit). Replaces `issueToken`.
- `Auth.getPresentedUserToken()`: immutable token of the initial request, kept by `RequestSession.restore`.
- Presented-session-token guard (`401 session_revoked`) on session-initiated changes of `users`: `changePassword`, `startPhoneLink`, `confirmPhoneLink`, `startEmailLink` (issuance), `logoutAll`, avatar upload/delete.
- OAuth behaviour unchanged (feat-097).

## State

- Baseline `./init.sh` green on 2026-11-03: backend 1928, frontend 372, api-playground 62, shared 25, documentation 26.
- Implementation and tests done; PR open. Next: green CI → merge → «Mark feat-096 done» PR → start feat-097.

## Files modified

- Contract: `one-time-token.ts` (`runTokenTransaction`, `issueTokenLocked`), `token-repository.ts` (`clock_timestamp()`, `burn`, executors), `user-repository.ts` (`lockById`, `updateIfSessionToken`, guarded `changePasswordIfCurrent`), `sms-auth-challenge-repository.ts` (executor), `errors.ts` (`sessionRevoked`), `types.d.ts` / `request-session.ts` / `http-context.ts` (`getPresentedUserToken`).
- Flows: `email-verification-service.ts`, `password-reset-service.ts` (phone challenges retired inside the reset transaction), `auth-service.ts`, `avatar-service.ts`, `auth-controller.ts`, `avatar-controller.ts`.
- Docs: `documentation/backend/auth.md` («Зміни облікових даних із сесії», getter), `documentation/backend/repositories.md`, ADR 0002 note.

## Decisions

- `changePassword` that loses the conditional update re-reads the row: a different password → `409` (concurrent change), the same password → `401 session_revoked`.
- `verifyEmail` link branch refuses (409) when the locked user already has an email.
- Mail failure after `issueTokenLocked`: the earlier link is already retired; the user asks again (plan, ревізія 3).
- Avatar: the row is updated first; a refused update deletes the new object and keeps the old one.

## Evidence of Completion

- `pnpm typecheck` clean, `pnpm lint` clean, `pnpm format:check` clean.
- `pnpm test`: backend 1986 / frontend 372 / api-playground 62 / shared 25 / documentation 26.
- `pnpm --filter backend test:pg` 163 (PG 16 pgvector), `test:redis` 88.
- `pnpm docs:build && pnpm docs:verify` clean.
- Mutation checks (each makes a new pg test fail): `now()` instead of `clock_timestamp()`; `issueTokenLocked` without the user lock (2 tests); `changePassword` without the presented-token condition.
- Manual on `dist` (port 3091, local PG + Redis): login A and B → change-password from A `200` (`sessionRenewed: true`) → B `/main/init` `401`, B change-password `401` → A `/main/init` `200` → logout-all `200` → A `/main/init` `401`.
- No UI change; frontend e2e runs in CI.
