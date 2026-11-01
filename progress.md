# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-072 - Email Templates (in progress, H3)
**Branch:** `refactor/email-templates`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase H3

## Status

### Done

- [x] `app/services/notifications/email-templates.ts`: `EMAIL_BRAND`, `escapeHtml`, `renderBrandedEmail({ subject, preheader?, eyebrow, title, name, intro, action, footer, textLines })`. `action` is `{ kind: 'button', label, url }` (button plus the alternative-link box) or `{ kind: 'link', url }` (the address alone), which is the one real difference between the three layouts; the preheader is optional (the e-mail-linking mail has none)
- [x] The three builders of `password-reset-service.ts` and `email-verification-service.ts` (reset, verification, e-mail linking) now only pass their words; the two copies of `EMAIL_BRAND` and the two of `escapeHtml` are gone. About 200 lines of HTML template removed
- [x] **Byte-identical**: the nine file snapshots of G1 (`auth/__snapshots__`: three mails × plain, markup and blank name) pass untouched and the files are unchanged in git. Changing one digit of the layout (`17px 28px` → `17px 29px`) fails 6 of 9, so they do bite
- [x] `email-templates.spec.ts` (8): escaping (ampersand first), blank-name greeting, name and address escaped in html and not in text, button vs link action, optional preheader
- [x] Docs: `backend/mail.md` names the shared layout

## Evidence of Completion

| Check                                      | Result                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| G1 mail snapshots                          | 9 passed, files unchanged                                              |
| Mutation of the layout                     | 6 of 9 snapshot tests fail                                             |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                 |
| `pnpm test`                                | backend 1699 (+8), frontend 257, api-playground 29, shared 17, docs 26 |
| `docs:build && docs:verify`                | passed                                                                 |

## Notes for Next Session

1. Merge this PR; then a PR flipping feat-072 to `done` and starting feat-073
2. Next: H4 (feat-073, one-time tokens): the B2 race and fault-injection tests (`one-time-token-race.pg.test.ts`, needs PG_TEST_URL and ideally Redis) are the net
