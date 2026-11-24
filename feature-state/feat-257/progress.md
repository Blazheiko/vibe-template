# feat-257: MFA Continuation Binding

## Status

Implemented, ready for review. Branch `fix/mfa-continuation-binding`. Plan:
`docs/plan/mfa-review-fixes-7-plan.md`, items 2 and 7; `mfa_bind` approved by the owner on
2026-11-24 (csrf_guard and the `account_changed` reload stay).

## Scope

2. The second-step ticket is bound to its own cookie `mfa_bind` (`__Host-mfa_bind`): a random value
   per ticket, set and cleared with the ticket cookie, same attributes (`Path=/`, HttpOnly,
   SameSite=Strict, same lifetime). `getCookieSessionId` and the session-id parameter of
   `startSecondStepIfRequired` are removed. Client: the sign-in page's page-load
   `POST /auth/mfa/state` also runs on an OAuth return (`?mfa=required`), and the MFA form continues
   once that answer says `completing`. Plan revision 8 of Р4.
3. The activation reads the user before it issues the cookie (a repeatable failure answers
   `mfa_completion_pending` without a cookie); after the cookie a WebSocket token Redis cannot
   issue is left empty (`authSuccessPayload` `wsToken: 'optional'`, MFA activation only) and
   main/init brings it.

## Deviations from the plan

- The plan's "same account" client path (`mfa/state` then `continue` after `csrf_invalid`) needs
  no form code: `base-api` already refreshes the CSRF token and resends the kept request, which
  `mfa_bind` now admits.
- A signed-in session of another account in front of the MFA form cannot be reached from the UI
  (App moves a signed-in user off `/login`). The live test makes it by API in the same browser
  (sign in as the other account, start the sign-in, verify outside the browser so its answer is
  lost), then loads the OAuth return page, which finishes the sign-in.
- No real OAuth provider in the live run: the anonymous Redis-stored previous session is made by
  `GET /auth/oauth/google/redirect` with a dummy Google client (never followed).

## Evidence of Completion

- `make check` green: backend 3702, frontend 1015, shared 149, landing 103, api-playground 115,
  documentation 26.
- `pnpm --filter backend test:pg` (PG_TEST_URL set): 72 files, 717 passed, 0 skipped.
- `pnpm --filter backend test:redis` (REDIS_TEST_URL set): 20 files, 205 passed.
- `pnpm --filter frontend test:e2e`: 134 passed (mock `mfa.spec.ts` re-run after a lint fix: 7).
- `test:e2e:live`: main run 43 passed, 1 failed (`account-profile.spec.ts:170`, local only: more
  than 100 accounts in the local live database; CI starts empty), `mfa-continuation.spec.ts` 2
  passed; `playwright.live-passkey.config.ts` 3 passed; `playwright.live-prefix.config.ts`
  (API_PATH_PREFIX=v2/api, own build) 2 passed.
- `pnpm docs:build && pnpm docs:verify`: passed.
- CI on the branch: see the PR.

## Manual verification

Golden path in a real browser against the real backend (live suite above): a lost activation
answer after an OAuth start and after another account's session, finished without a new code,
with the default and a custom API prefix.
