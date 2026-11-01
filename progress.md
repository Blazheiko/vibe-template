# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-075 - Frontend And Shared Dedup (in progress, phase I)
**Branch:** `refactor/frontend-shared-dedup`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase I. The feature is done in several PRs; this is the first

## Status

### Done in this PR (items 3, 4, 5 of phase I)

- [x] **Password limits.** `PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_LENGTH` in `shared/limits`; `frontend/src/utils/validate-password.ts` (`passwordLengthProblem`, `PASSWORD_PROBLEM_MESSAGE_KEY`) replaces the six hand-written length checks of `AuthModals.vue` (login, forgot-by-phone, the two registration forms), `ResetPasswordView.vue` and `UserAccount.vue`. The shared tests check that every auth schema (register, login, change, reset) accepts exactly the range `[PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]` and refuses one outside it: that is what holds the browser's constants and the schemas together, since the browser cannot import the schemas
- [x] **Behaviour change, as the plan says:** the two registration forms and the new-password field of the phone password reset now refuse a password longer than 32 characters on the client ("Password must be at most 32 characters long"). The server refused it anyway (422); the form just said nothing until the request came back. The login form still checks only the minimum (as before). G2 has a new row (`a password of 33 characters is refused on the client`)
- [x] **Phone shape.** `looksLikePhoneNumber` was copied in `AuthModals.vue`. The plan says to take it from `shared/utils`, but that module imports `libphonenumber-js` and would bring it into the browser bundle; so it moved to a new dependency-free subpath `shared/patterns`, which `shared/utils` re-exports for its existing callers. Checked: the built frontend contains no `libphonenumber`
- [x] **Entity id.** One regex, `ENTITY_ID_PATTERN` in `shared/patterns`, used by `shared/brands/ids.ts` (`EntityIdSchema`), `backend/.../entity-id.ts` and `frontend/.../ws-payload-guards.ts`; a shared test checks the pattern against the schema on 10 inputs
- [x] Docs: `shared/index.md` (the two dependency-free subpaths), `guide/project-structure.md`

### Left for the next PRs of phase I

- [ ] WS transport into `shared/ws-client` (the biggest)
- [ ] `event-bus.ts` (frontend uses mitt, the playground a hand-rolled copy; the playground has no `mitt` dependency)
- [ ] Admin views: `useAdminUserDetailModal`, `AdminFilterBar.vue`, `buildAdminQuery()` + `encodeURIComponent`, shared `admin.css` (screenshots before and after)
- [ ] `sentry-service.ts` `sanitizeTree`
- [ ] ArkType `.default()` typing check (the casts in `query/*.ts`)

## Evidence of Completion

| Check                                      | Result                                                            |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                            |
| `pnpm test`                                | shared 19, frontend 261, backend 1731, api-playground 29, docs 26 |
| Playwright `mock` project                  | 61 passed (60 + the new row)                                      |
| `libphonenumber` in the frontend bundle    | none                                                              |
| `docs:build && docs:verify`                | passed                                                            |

## Notes for Next Session

1. Merge this PR; the next one is whichever remaining item is smallest (sentry `sanitizeTree` or the ArkType check)
