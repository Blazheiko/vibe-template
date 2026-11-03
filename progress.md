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

## Evidence of Completion

_pending_
