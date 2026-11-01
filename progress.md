# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-068 - Frontend, service worker and playground hardening (in progress)
**Branch:** `fix/frontend-hardening`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase F4

## Status

### Done

- [x] Password fields (`UserAccount.vue`): `name` and `autocomplete` on all five password inputs (`current-password` for the current password and for the two re-authentication fields, `new-password` for the new and confirm fields), and on the contact fields (`tel`, `country`, `one-time-code`, `email`). A component test mounts the real view and checks them
- [x] Service worker (`service-worker.ts`): `notification-target.ts` — the push payload's `url` is resolved against the app origin and anything that leaves it (another host / port / scheme, `//host`, `/\host`, `javascript:`, `data:`, non-strings) falls back to `/`; an already-open window is matched by origin + `pathname`, not by `client.url.includes(url)` (which took `/support/archive`, or any address merely containing the target, for the page)
- [x] Redirect after sign-in (`App.vue`): `safe-redirect.ts` — only `startsWith('/') && !startsWith('//')`, no backslash, no control characters, a string (an array from a repeated `?redirect=` is refused)
- [x] Playground: header **values** (Authorization, Cookie, API keys) are kept in `sessionStorage` (one tab) and never in `localStorage`; values an older version left in `localStorage` are ignored and wiped; the settings log no longer prints them; the request log redacts credential headers (`redact-headers.ts`); `vite.config.ts` has `esbuild.pure` for `console.log/info/debug/trace` like the frontend (a production build contains no "Making API request" string)
- [x] Tests first: store (4 of 7 failed against the original store, including a log test that was first too weak to fail), `redact-headers`, `notification-target`, `safe-redirect`, `UserAccount` component test (mutation: dropping one `autocomplete` fails it)
- [x] Docs: `playground/index.md`, `frontend/index.md`, `backend/web-push-notification.md`

### Behaviour changes to know

- A notification whose `data.url` points outside the application now opens the start page instead.
- A `?redirect=` that is not an in-app path is ignored (the user lands on `/account`).
- The playground forgets typed header values when the tab closes (it used to keep them for ever).

## Evidence of Completion

| Check                                      | Result                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| Tests first                                | 4 store tests failed against the original store; the pure helpers did not exist |
| Mutation: one `autocomplete` removed       | 1 component test fails                                                          |
| Playground production build                | no "Making API request" string left in `dist` (`esbuild.pure`)                  |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                          |
| `pnpm test`                                | backend 1398, frontend 257, api-playground 29, shared 17, docs 26; exit 0       |
| `docs:build && docs:verify`                | passed                                                                          |
| Backend suites                             | not affected (no backend change)                                                |

## Notes for Next Session

1. Merge this PR; then a PR flipping feat-068 to `done`
2. Next: F1 (feat-065) with the plan's recommended default (hash + length by default, full text only with `AI_USAGE_STORE_PROMPTS=true`, retention 30 days, purge script)
