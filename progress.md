# feat-089 — Result For Expected Outcomes (1/3)

Plan: `docs/plan/error-handling-fix-plan.md`, stage 4, PR 1 of 3. ADR: `docs/adr/0004-result-for-expected-outcomes.md`.

## Current state

Implemented, awaiting review. Start PR #298 merged (feat-088 → done, feat-089 → `in_progress`).

## Changes

1. **ADR 0004**: `Result` only for outcomes the client must tell apart; infrastructure failures throw; the exception path answers like a returned error; best-effort steps and background tasks catch locally.
2. **Prerequisite found while implementing**: a thrown error went to `handleError` → `sendErrorResponse`, which wrote no cookies, skipped `session.beforeSend` and sent no CORS headers. A `Result` error answered through `sendResponse` with them. Moving to exceptions would have left a client with a deleted session's cookie after a failure following `auth.login`. `server.ts` now runs `beforeSend` on the error path and passes the request's cookies and Origin to `sendErrorResponse` (CORS headers on error answers were missing before, for every thrown error).
3. **Services without `tryInternal`** (37 calls removed, 71 left in auth services for PR 2/3): `avatar-service`, `push-subscription-service`, `knowledge-base-service`, `support-service`, `main-service`. Best-effort S3 deletes catch locally (`warn`). The support admission frees its lock when the budget reservation throws, then rethrows.

## Behaviour changes (intended, no compatibility needed)

- Infrastructure 500 text is `Internal server error` instead of `Failed to upload avatar` etc. No client matches those texts (only a `console.error` label in `UserAccount.vue`).
- WS support admission during a Redis outage: `service_unavailable` now comes as a transport error (`error` envelope) instead of a business error in `data`; the frontend rejects both the same way (`hasResponseError`) and shows the same text.
- The 500 log record now carries `route` and `method` (handleError context) in addition to `requestId`/`userId`.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 1916, frontend 373, api-playground 62, shared 25, documentation 26 passed.
- `test:redis` 89, `test:pg` 152 (local; include support history/admission and push ownership over HTTP).
- `pnpm docs:build && pnpm docs:verify` passed.
- New tests: a thrown error keeps the cookies set before it (`http-cache-control.spec.ts`, fails if the cookies are not passed) and writes CORS headers; repository failures propagate (`rejects`) in avatar, KB, support specs; the support lock is freed when the budget check throws (fails without the `releaseLock` in the catch).
- Manual on a fresh `dist` build (S3 on a closed port): avatar upload → 500 `{ code: 'internal_error', message: 'Internal server error' }`, one `error` record with `requestId`, `userId`, `route: api/avatar/upload`. Test user deleted afterwards.
- Not run: a manual Redis outage for the support admission (covered by unit tests + `classifyError`).

## Files modified

- `docs/adr/0004-result-for-expected-outcomes.md` (new), plan stage 4 note
- `packages/backend/src/vendor/start/server.ts`, `src/vendor/utils/network/http-response-handlers.ts` (`setCookies` takes a `ReadonlyMap`)
- `packages/backend/src/app/services/{user/avatar,notifications/push-subscription,support/knowledge-base,support/support,core/main}-service.ts` + specs; `avatar-controller.spec.ts`; `http-cache-control.spec.ts`
- Docs: `documentation/backend/{services,adding-a-feature,repositories,ai,observability,request-lifecycle}.md`

## Next step

Review + merge, then "Mark feat-089 done" and PR 2/3: `oauth-service`, `email-verification-service`, `password-reset-service`, `sms-challenge`, `one-time-token` (37 calls).
