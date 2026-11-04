# feat-108 — Mail Escaping and OAuth Fetch

Plan: `docs/plan/code-review-2026-11-03-plan.md`, item R05 (findings 5, 8). Branch: `fix/feat-108-mail-escaping-oauth-fetch` (from `main` after #357).

## Current State

Implemented; PR open.

- `email-templates.ts` `renderBrandedEmail`:
    - escapes every HTML field: `preheader`, `eyebrow`, `title`, `intro`, the button label and `footer`, as well as the name and the URL as before;
    - the plain-text body stays text;
    - no caller passed markup, so the snapshots are unchanged.
- `oauth-service.ts`:
    - `fetchJson` throws on a non-2xx answer, and the callback answers `Failed to exchange authorization code`;
    - GitHub `/user/emails` that is not an array reads as no verified address;
    - an empty or non-string/number profile `id` is refused before any lookup (`Could not retrieve account id from provider`).
- Docs: `documentation/backend/oauth.md` (callback steps), `documentation/backend/mail.md`.

## Files Modified

- `packages/backend/src/app/services/notifications/email-templates.ts` + spec
- `packages/backend/src/app/services/auth/oauth-service.ts` + spec (fetch stubs answer `ok: true, status: 200`)
- `packages/backend/src/app/services/auth/oauth-pre-hijack.pg.test.ts` (stub `ok`, mail capture keeps `html`, new feat-108 block)
- `documentation/backend/oauth.md`, `documentation/backend/mail.md`

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 2258, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` locally with `PG_TEST_URL` and `REDIS_TEST_URL`: 23 files / 210 tests passed, nothing skipped.
- Unit:
    - each HTML field and the button label escape a markup payload;
    - 401/403/429/500/503 from Google's profile API → failed sign-in, no lookup, nothing created;
    - missing, empty and object ids → refused before the lookup;
    - non-array GitHub emails → no email.
- PG (`oauth-pre-hijack.pg.test.ts`, real PostgreSQL):
    - a provider 500 → nobody signed in, no user, no `(facebook, '')` row;
    - two profiles without an id → both refused, no shared account;
    - a Google profile name with markup → the mailed link HTML contains it only escaped.
- Mutation check: with `main`'s `oauth-service.ts` and `email-templates.ts`, every new case fails except "plain text stays text", which is a guard. That is 15 unit cases and the 3 PG cases.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next by the plan order (wave 3): R06b (reauth throttle and pending tokens).
