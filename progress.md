# feat-163 — Dead Code Cleanup (V17)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V17), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (V17.S–V17.X). Depends on feat-148 and feat-162.

## State

Done, waiting for review and merge.

## V17.1 Usages on a fresh `main` (production code; dist/ and built bundles not counted)

| Item                                                                                                           | Usages                                                                 | Action                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/scripts/copy-static.js`                                                                           | 0 (no script, Makefile or Dockerfile)                                  | deleted                                                                                                                                                                                                                                       |
| `MainController.testHeaders` / `getSetCookies` / `testSession`                                                 | 0 routes                                                               | deleted with the `mainService` methods, the three shared response schemas and `main-service.spec.ts` (it tested only `testHeaders`)                                                                                                           |
| `token` in `LoginInputSchema`, `RegisterEmailInputSchema`, `RegisterPhoneCompleteInputSchema`                  | the backend never read it; the frontend always sent `''`               | removed from the schemas, the `token` prop of `AuthModals`, `LoginForm`, `RegisterEmailForm`, `RegisterPhoneFlow`, and from 52 places in tests and e2e helpers. A client that still sends `token` now gets 422: the schemas reject extra keys |
| `sms_auth_challenges.send_count`                                                                               | 0 reads, 0 writes (always the default `1`)                             | dropped: migration `20261111120018_sms_challenge_drop_send_count`                                                                                                                                                                             |
| `stores/counter.ts`, `utils/isToday.ts`, `ConnectionStatus.vue`, `LoaderOverlay.vue`, `components/icons/*` (5) | 0                                                                      | deleted                                                                                                                                                                                                                                       |
| `useLocale()`                                                                                                  | 0 (the module's `initLocaleStandalone` and `supportLanguage` are used) | the function is deleted, the module stays                                                                                                                                                                                                     |
| `authApi.register`, `supportApi.getScreenshotUrl`                                                              | 0                                                                      | deleted                                                                                                                                                                                                                                       |
| `pushSubscriptionApi.getSubscription` / `getSubscriptionStatistics` / `deactivateSubscription`                 | 0                                                                      | **kept**: they are the whole push group of the contract pilot (ADR 0005); C4 decides how wrappers without a caller are treated                                                                                                                |
| `authApi.logoutAll`                                                                                            | 0 in the UI, a tested wrapper of a real route                          | kept                                                                                                                                                                                                                                          |
| event `destroy_websocket_base`                                                                                 | listened to, never emitted                                             | deleted                                                                                                                                                                                                                                       |
| notification sound button, event `toggle_notifications`, `notifications_enabled`                               | the event had no listener: the button changed nothing                  | deleted                                                                                                                                                                                                                                       |
| `public/audio/*.mp3` (4 files, 730 KB) and the `/audio/` static prefix                                         | 0 since feat-162 took them out of the precache                         | deleted                                                                                                                                                                                                                                       |

**V17.4 decision, `useToast` / `ToastContainer`:** `useToast` had no caller, so the container never
showed anything. Removed together with `stores/toast.ts`. A future feature that needs toasts adds them back with a caller and a test.

Docs (both locales): `backend/database.md` (the migration), `frontend/index.md` (the removed
components, composable and stores). `src/composables/README.md` updated.

## Evidence of Completion

- `make check`: backend 195 files / 2654 tests (−1: the deleted `main-service.spec.ts`),
  frontend 499, shared 30, playground 111.
- `pnpm --filter backend test:pg` (with `REDIS_TEST_URL`): 31 files / 295 passed, migrations
  applied up to the new one.
- `pnpm --filter frontend test:e2e`: 92 passed; `test:e2e:live`: 13 passed;
  `test:e2e:security` (with `PGSQL_DB_NAME=vibe_e2e_live`): 7 passed.
- `pnpm docs:build && pnpm docs:verify`: passed.
- Precache: the 4 mp3 files (730 KB) are gone from `public/` and the `/audio/` cache-first prefix.

Nothing new to test: this is removal only. The suites above show nothing depended on it.

### Not verified

- `test:e2e:security` does not start on a database server that lacks the default database
  (`3D000`). That is an environment issue, not caused by this change. It ran against the
  database the live suite creates.
