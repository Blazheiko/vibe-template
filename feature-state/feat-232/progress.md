# feat-232 Profile Editing — progress

Plan: `docs/plan/profile-editing-plan.md` (revision 3, Р1–Р8, Р10–Р13), tasks: `docs/plan/profile-editing-tasks.md` (T1–T16). Feature B (live WS sync, Р9 B) is out of scope.

## Current state

T1–T15 done on `feat/profile-editing`; T16 checks below. Registry PR #710 (plan + `feat-232` row as `in_progress`) is open, not merged. Next: merge #710, merge the implementation PR after green CI, a separate PR to set `review`, an independent review, then "Mark feat-232 done".

## Decisions taken while implementing

- **Limit as a variable** (T6): `AUTH_PROFILE_MAX_UPDATES_PER_USER_PER_10_MIN`, default 30, fixed 10-minute window, like the other `readInt` throttle variables; in `.env.example`, `configuration.md` and the `security.md` limits table.
- **Time zone aliases** (Р3): ICU's `Intl.supportedValuesOf('timeZone')` keeps the older CLDR names (`Europe/Kiev`, `Asia/Calcutta`) while browsers may report `Europe/Kyiv`. `isAllowedTimeZone` accepts a listed zone, `UTC`, or a name `Intl.DateTimeFormat` resolves to a listed zone; offsets like `+02:00` are refused.
- **Revoked session** (A5): the write is conditional on `users.session_token` (`updateNameIfSessionToken`, or `shareIfSessionToken` = `SELECT … FOR SHARE` when no name), plus `session.isStored()` before the transaction, as the password change does. Over HTTP a revoked session gets `403 csrf_invalid` (its record is gone, `csrf_guard` answers first), the same answer as `change-password`.
- **Response shape**: `{ status: 'success', profile }` for both routes (tutorial convention).
- **Profile form vs autosave**: the name, language and zone are a form with a Save button; the theme, color and font size save at once through the queue (font size after 600 ms). Both go through the same one-per-tab queue, so there is never more than one PATCH in flight.
- **Device keys**: `theme` is now written to `localStorage` only on an explicit choice of an anonymous visitor; while signed in, the account cache `prefs:<userId>` (and the pointer `prefs:current` for the first frame) is used.
- **Name length** counts code points (as `varchar(100)`), not UTF-16 units.

## Files

shared: `enums/preferences.ts`, `utils/time-zone.ts`, `schemas/account/{profile-name,update-profile}.ts`, `responses/account-controller.ts`, `responses/main-controller.ts`, `contracts/account.ts`, `test/profile.test.js`.
backend: `database/{schema,relations}.ts`, migration `20261119141051_user_preferences`, `repositories/user/{user-preferences-repository,user-repository}.ts`, `transformers/profile-transformer.ts`, `services/user/account-service.ts`, `services/core/main-service.ts`, `controllers/http/user/account-controller.ts`, `routes/{http-routes,contract-schemas/account}.ts`, `config/throttle-policies.ts`, `.env.example`, tests.
frontend: `stores/{state,user}.ts`, `composables/{useProfileSave,usePreferences,useDateFormat,useLocale}.ts`, `App.vue`, `views/UserAccount.vue`, admin views/modal, `components/MenuButton.vue`, `utils/api.ts`, locales, tests, `e2e/mock/account-profile.spec.ts`, `e2e-live/account-profile.spec.ts`, `playwright.live.config.ts`.
docs: `documentation/{,en/}backend/account.md` (new), `database.md`, `configuration.md`, `security.md`, `reference/roles-capabilities.md`, `frontend/index.md`, sidebar, `verify-dist.mjs`; `docs/plan/future/template-functionality-recommendations.md`.

## Evidence of Completion

All on 2026-11-19, local, PostgreSQL `pgvector/pgvector:pg16` and `redis:7-alpine`.

- `./init.sh` at the start: green (backend 3141, frontend 614, landing 103, api-playground 115 tests).
- `make check`: exit 0. backend 226 files / 3162 tests, frontend 58 / 661, landing 6 / 103, api-playground 11 / 115, shared 48 pass / 0 fail, documentation 26 / 0.
- `PG_TEST_URL=… REDIS_TEST_URL=… make test-pg`: 40 files passed, **377 tests passed, 0 skipped** (new: `account-preferences.pg.test.ts` 11, `account-service.pg.test.ts` 7, `account-http.pg.test.ts` 7).
- `REDIS_TEST_URL=… make test-redis`: 17 files passed, **151 tests passed, 0 skipped** (new: `account-throttle.redis.test.ts` 4).
- `pnpm --filter frontend test:e2e`: 102 passed (new: `e2e/mock/account-profile.spec.ts` 3).
- `pnpm --filter frontend test:e2e:live` (PGSQL/REDIS pointed at the containers above): 20 passed (new: `e2e-live/account-profile.spec.ts` 4).
- `pnpm docs:build && pnpm docs:verify`: "verify-dist: all checks passed".

### Mutations (each fails its test, then reverted)

| Guarantee          | Mutation                                                                 | Failed                                                                                 |
| ------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Atomicity          | the name written in its own `withTransaction`                            | `account-service.pg.test.ts`: 2 (rollback of the name)                                 |
| Revision increment | `revision = user_preferences.revision` on UPDATE (no `+1`)               | 7 across `account-service.pg`, `account-http.pg`, `account-preferences.pg`             |
| Newer input kept   | an answer clears every pending field it sent, whatever its current value | `useProfileSave.spec.ts`: 2 (success with the old value; failure of the older request) |
| Account isolation  | the queue checks neither the owner nor the epoch                         | `useProfileSave.spec.ts`: 5                                                            |

### Golden path

Automated against the real backend in `e2e-live/account-profile.spec.ts`: two browser contexts of one account — name, language, zone and theme changed in one, a reload of it and a sign-in in the other show the same; "Same as the system" follows `colorScheme` after a reload; sign-out and sign-in as another user in the same context shows the default look; a name `<img src=x onerror=alert(1)>` is text in the account header, the admin list and the admin card, no dialog, no `img[src=x]`. A manual click-through in a real browser has not been done yet.

## Notes for Next Session

- Feature B (WS `user.profile_updated`, re-read after reconnect) needs its own `feat-XXX` and a cross-process broadcast for several instances.
- Open question 1 of the plan (language choice on the login page for anonymous visitors) stays open.
