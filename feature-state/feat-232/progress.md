# feat-232 Profile Editing — progress

Plan: `docs/plan/profile-editing-plan.md` (revision 3, Р1–Р13), tasks: `docs/plan/profile-editing-tasks.md` (T1–T16 and feature B). Owner decision 2026-11-19: the whole plan, A and B, in `feat-232` and one implementation PR.

## Current state

Feature A (T1–T15) and feature B (live sync) done on `feat/profile-editing`; T16 checks below. Registry PR #710 (plan + `feat-232` row covering A and B, `in_progress`) is open, not merged; the implementation PR #711 is a draft until the owner says to proceed. Next: merge #710, mark #711 ready and merge it after green CI, a separate PR to set `review`, an independent review, then "Mark feat-232 done". A manual click-through in a real browser is still to do.

## Decisions taken while implementing

- **Limit as a variable** (T6): `AUTH_PROFILE_MAX_UPDATES_PER_USER_PER_10_MIN`, default 30, fixed 10-minute window, like the other `readInt` throttle variables; in `.env.example`, `configuration.md` and the `security.md` limits table.
- **Time zone aliases** (Р3): ICU's `Intl.supportedValuesOf('timeZone')` keeps the older CLDR names (`Europe/Kiev`, `Asia/Calcutta`) while browsers may report `Europe/Kyiv`. `isAllowedTimeZone` accepts a listed zone, `UTC`, or a name `Intl.DateTimeFormat` resolves to a listed zone; offsets like `+02:00` are refused.
- **Revoked session** (A5): the write is conditional on `users.session_token` (`updateNameIfSessionToken`, or `shareIfSessionToken` = `SELECT … FOR SHARE` when no name), plus `session.isStored()` before the transaction, as the password change does. Over HTTP a revoked session gets `403 csrf_invalid` (its record is gone, `csrf_guard` answers first), the same answer as `change-password`.
- **Response shape**: `{ status: 'success', profile }` for both routes (tutorial convention).
- **Profile form vs autosave**: the name, language and zone are a form with a Save button; the theme, color and font size save at once through the queue (font size after 600 ms). Both go through the same one-per-tab queue, so there is never more than one PATCH in flight.
- **Device keys**: `theme` is now written to `localStorage` only on an explicit choice of an anonymous visitor; while signed in, the account cache `prefs:<userId>` (and the pointer `prefs:current` for the first frame) is used.
- **Name length** counts code points (as `varchar(100)`), not UTF-16 units.
- **Feature B event name**: `user_profile_updated` (snake_case like the other events of the registry), not `user.profile_updated` as the plan wrote it.
- **Cross-process delivery** (the plan's prerequisite of B): `app/services/communication/user-event-bus.ts`, Redis pub/sub on `<REDIS_PREFIX>user-events`. Every instance subscribes at startup (not awaited: SUBSCRIBE waits for Redis), the publishing instance included, and delivers through its local `broadcastMessageToUser`. Only `BUS_EVENTS` (`user_profile_updated`) are allowed; a failed publish or a bus that is not started falls back to this process. Stopped first in the graceful shutdown.
- **Re-read after reconnect**: the WS client emits `ws_connected`; `createProfileLiveSync` reads `GET /account/profile` on every connection but the first of an account and drops an answer that arrives after the account changed.

## Review 2026-11-19 (REQUEST CHANGES, six P2 findings): all fixed

| #   | Finding                                                                                                                         | Fix                                                                                                                                   | Test that reproduces it (fails on the old code)                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `GET` and `init` read the name and the preferences separately: an old name could pair with a new revision                       | one statement `users LEFT JOIN user_preferences` (`findProfileByUserId`); `init` takes its name from it                               | `account-service.pg.test.ts` "pairs each name with its own revision" (40 name-only PATCHes vs 3 readers): old code failed 3 of 3 runs; unit "one statement, nothing else" |
| 2   | one form-wide dirty flag: saving the name sent back a stale language changed by another tab                                     | each form field tracked on its own; untouched fields follow the profile; only edited fields are sent                                  | `UserAccount.spec.ts` "a language changed in another tab is shown and not sent back with the name"                                                                        |
| 3   | a success re-synced the whole form, erasing text typed while the request was under way                                          | after an answer a field follows the profile again only if it still holds what was sent                                                | `UserAccount.spec.ts` "text typed while the save is under way is kept after its answer"                                                                                   |
| 4   | the first WS connection skipped the re-read, so a change between init and the socket was lost                                   | re-read after every connection, the first one included                                                                                | `profileLiveSync.spec.ts` "reads the profile after every connection, the first one included"                                                                              |
| 5   | the sync showed the device look while the session was not yet checked, undoing the `prefs:<userId>` cache                       | `userStore.anonymousConfirmed` (a 401 at init or a sign-out); until then the cache stays                                              | `preferences.spec.ts` "keeps the cached look while the session is not checked yet" (real stores + `useProfileSync`)                                                       |
| 6   | the subscriber was set before SUBSCRIBE finished: a PUBLISH in that gap reached nobody here, and the local fallback did not run | `publishToUser` delivers to this process first, always; the envelope carries `origin` (an id per process) and the own echo is skipped | `user-event-bus.spec.ts` "while SUBSCRIBE is still pending, the event reaches this process" (+ "own echo is skipped")                                                     |

## Files

shared: `schemas/ws/broadcast-events.ts` (`user_profile_updated`), `enums/preferences.ts`, `utils/time-zone.ts`, `schemas/account/{profile-name,update-profile}.ts`, `responses/account-controller.ts`, `responses/main-controller.ts`, `contracts/account.ts`, `test/profile.test.js`.
backend: `app/services/communication/user-event-bus.ts` (+ spec, redis test), `index.ts` (bus start/stop), `database/{schema,relations}.ts`, migration `20261119141051_user_preferences`, `repositories/user/{user-preferences-repository,user-repository}.ts`, `transformers/profile-transformer.ts`, `services/user/account-service.ts`, `services/core/main-service.ts`, `controllers/http/user/account-controller.ts`, `routes/{http-routes,contract-schemas/account}.ts`, `config/throttle-policies.ts`, `.env.example`, tests.
frontend: `utils/{ws-payload-guards,event-bus}.ts`, `composables/useWebSocketConnection.ts`, `stores/{state,user}.ts`, `composables/{useProfileSave,usePreferences,useDateFormat,useLocale}.ts`, `App.vue`, `views/UserAccount.vue`, admin views/modal, `components/MenuButton.vue`, `utils/api.ts`, locales, tests, `e2e/mock/account-profile.spec.ts`, `e2e-live/account-profile.spec.ts`, `playwright.live.config.ts`.
docs: `documentation/{,en/}backend/account.md` (new), `websocket.md` (user event bus, event row), `database.md`, `configuration.md`, `security.md`, `reference/roles-capabilities.md`, `frontend/index.md`, sidebar, `verify-dist.mjs`; `docs/plan/future/template-functionality-recommendations.md`.

## Evidence of Completion

All on 2026-11-19, local, PostgreSQL `pgvector/pgvector:pg16` and `redis:7-alpine`.

- `./init.sh` at the start: green (backend 3141, frontend 614, landing 103, api-playground 115 tests).
- `make check` (after the review fixes): exit 0. backend 227 files / 3175 tests, frontend 59 / 698, landing 6 / 103, api-playground 11 / 115, shared 48 pass / 0 fail, documentation 26 / 0.
- `PG_TEST_URL=… REDIS_TEST_URL=… make test-pg`: 40 files passed, **378 tests passed, 0 skipped** (new: `account-preferences.pg.test.ts` 11, `account-service.pg.test.ts` 7, `account-http.pg.test.ts` 7).
- `REDIS_TEST_URL=… make test-redis`: 18 files passed, **153 tests passed, 0 skipped** (new: `account-throttle.redis.test.ts` 4, `user-event-bus.redis.test.ts` 2: two instances on one Redis, another prefix isolated).
- `pnpm --filter frontend test:e2e`: 102 passed (new: `e2e/mock/account-profile.spec.ts` 3).
- `pnpm --filter frontend test:e2e:live` (PGSQL/REDIS pointed at the containers above): 21 passed (new: `e2e-live/account-profile.spec.ts` 5, among them two tabs of one session and another browser getting a theme and name change without a reload).
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

- Open question 1 of the plan (language choice on the login page for anonymous visitors) stays open.
