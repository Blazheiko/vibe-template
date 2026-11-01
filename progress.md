# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-064 - OAuth Token Storage (in progress)
**Branch:** `fix/oauth-token-storage`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase E

## Status

### Done

- [x] Diagnosis: `oauth_accounts.access_token` / `refresh_token` stored the provider's tokens in plaintext and nothing ever read them back (the tokens are used once, to fetch the profile). The Facebook token travelled in the query string (`?access_token=`), and the OAuth log wrote the raw email, name and provider id
- [x] Decision per the plan: do not store (no code needs offline access to a provider). If a product later needs it, store the tokens encrypted with a key separate from `APP_KEY`, together with the code that reads them
- [x] Tests first (`oauth-service.spec.ts`, 9 failed before the change): no token reaches `oauthAccountRepository.create` (Google and GitLab with a refresh token), a returning user writes nothing, the Facebook token is in `Authorization: Bearer` and not in the URL, the log carries a masked email and no name or token (returning, new, refused link)
- [x] `oauth-service.ts`: tokens are used for the profile request only; Facebook through the header; `maskEmailForLogs` in the log, no name / provider id / token in it; the "normalized email" log line is gone
- [x] Schema: `access_token`, `refresh_token` dropped; `updateTokens` removed from the repository; migration `20261101113023_drop_oauth_tokens` (a second `drizzle-kit generate` says "No schema changes")
- [x] `oauth-account-repository.pg.test.ts` on real PostgreSQL: the migrated table has no token columns and keeps the rest; create / find round trip
- [x] Docs: `backend/oauth.md` (what is stored, the log, the Discord example), `backend/repositories.md`

### Behaviour changes to know

- Existing `access_token` / `refresh_token` values are **deleted** by the migration and cannot be restored. Rollback of the schema: `ADD COLUMN access_token text, ADD COLUMN refresh_token text` (both were nullable).
- OAuth sign-in no longer writes to `oauth_accounts` for a returning user.
- The OAuth log no longer contains the user's name, the provider's user id or the raw email.

## Evidence of Completion

| Check                                      | Result                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| Tests first                                | 9 of the OAuth tests failed before the change                             |
| Mutation: raw email in the log, token back | 4 tests fail                                                              |
| `drizzle-kit generate` after the migration | "No schema changes, nothing to migrate"                                   |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                    |
| `pnpm test`                                | backend 1366, frontend 203, api-playground 14, shared 17, docs 26; exit 0 |
| `test:pg` with Redis / without             | 132 passed / 68 passed, 64 skipped (2 new on the migrated table)          |
| `test:redis`                               | 89 passed                                                                 |
| `docs:build && docs:verify`                | passed                                                                    |
| Grep                                       | no `access_token=` left in `packages/` (outside tests)                    |

## Notes for Next Session

1. Merge this PR; then a PR to `main` flipping feat-064 to `done`
2. Next: phase F (F1 needs the owner's decision on what to keep from prompts; F2–F4 are independent)
