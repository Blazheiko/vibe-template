# feat-200: OAuth Flow Hardening

Plan: `docs/plan/security-review-2026-11-12-plan.md`, S06. Findings: L-6, L-7, L-8, L-9, I-2 of
`docs/security/security-review-2026-11-12.md`. Decision Д4. Branch: `fix/oauth-flow-hardening`.

## Current State

Done, in review.

- **L-6 (Д4).** `GET /auth/oauth/:provider/redirect` refuses a navigation with
  `Sec-Fetch-Site: cross-site` (403, reason `oauth_cross_site_start`). `same-origin`,
  `same-site`, `none` and a request without the header go on. The frontend is unchanged.
- **L-7, state.** The provider is stored with the state (`oauthProvider`) and compared on the
  callback before the state is consumed; all three keys are consumed together.
- **L-7, PKCE.** GitHub and GitLab now send an S256 challenge and the verifier with the code.
  The ready-made `arctic` clients for them take no verifier (3.7.0 is the latest), so the
  service uses the generic `OAuth2Client` of the same library with the same endpoints. A
  callback without the verifier is refused for Google, GitHub and GitLab. Facebook has no PKCE.
- **L-8.** A GitLab address without `email_verified: true` is no address: the sign-in ends with
  "Could not retrieve email from provider" instead of taking the profile's `email`.
- **L-9, I-2.** The provider's profile name is cut to 255; the picture is kept only as an
  `https://` URL of at most 500 characters, otherwise `null`. Applied once, where the identity
  is built, so the link, the pending link and `users.avatar` all get the same values.

## Files Modified

- `packages/backend/src/app/services/auth/oauth-service.ts`,
  `app/controllers/http/auth/oauth-controller.ts`
- tests: `oauth-service.spec.ts`, `oauth-controller.spec.ts`,
  `vendor/utils/session/session-store.redis.test.ts`
- docs uk+en: `backend/oauth.md`

## Evidence of Completion

- `make check`: passing (backend 2861, frontend 558, playground 115).
- `pnpm docs:build && pnpm docs:verify`: passing.
- `pnpm --filter backend test:pg` (32 files, 312 passed) and `test:redis` (11 files, 117
  passed) on real services. On a real Redis: a state stored for another provider is refused
  and stays for its own callback.
- RED: with `oauth-service.ts` and `oauth-controller.ts` as on `main`, 56 cases of the two
  specs fail (most of them because the old code does not know the generic client; among them
  the new cases for the challenge, the verifier, the provider of the state, the cross-site
  start, the GitLab address and the profile fields).
- The authorization URL in the spec is built by the real library: `code_challenge` equals
  base64url(SHA-256(verifier)), `code_challenge_method` is `S256`.
- Manual, on the real server (`playwright.live.config.ts`, a temporary spec, not committed):
  `GET /api/auth/oauth/github/redirect` with `Sec-Fetch-Site: cross-site` answers 403 with
  `reason: oauth_cross_site_start`; with `same-origin`, `same-site`, `none` and without the
  header it reaches the provider check (404 here: no provider is configured locally).
- Whole `e2e-live` suite: 14 passed, twice. One earlier run failed once in
  `push-account-switch.spec.ts` with a 503 from the e-mail verification step of its setup,
  while the PG and Redis suites ran on the same machine; it did not repeat.
- **Not run: a sign-in against real GitHub, GitLab or Google.** No provider application is
  configured here. PKCE support is taken from the providers' documentation (GitHub: OAuth apps
  accept `code_challenge` with S256 on github.com, not on GitHub Enterprise Server 3.19; GitLab:
  PKCE for the authorization code flow). Whoever configures a provider should sign in once
  through GitHub and GitLab after this change.

## Notes for Next Session

The OAuth chain of the plan (feat-198, feat-199, feat-200) is complete. Still open of the
medium findings: M-3 (feat-201, feat-202).
