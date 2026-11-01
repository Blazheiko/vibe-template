# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-076 - Frontend Component Split (in progress, phase J, part 3)
**Branch:** `refactor/frontend-split-components-3` (part 1, `AuthModals.vue`, is merged as #260; part 2, `stores/state.ts`, as #261)
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase J

## Status

### Done in this PR (item 3 of phase J: the service worker out of `main.ts`)

`main.ts` was 401 lines, of which about 350 were the service worker; it is now 56 (bootstrap only):

- [x] **`utils/sw-manager.ts`**: the helpers (`parseBuildTimestamp`, `isServiceWorkerErrorPayload`, `createServiceWorkerError`, `isServiceWorkerVersionMessage`, `requestWorkerBuildTimestamp`), `createUpdateNotifier`, `ServiceWorkerManager` and `startServiceWorker({ appBuildTimestamp, reportError, announceUpdate })`. `main.ts` passes Sentry and the event bus in, so the module knows neither
- [x] **One `shouldNotify(source)`** instead of `showUpdateNotification` + `maybeShowUpdateNotification`: "tell the user at most once, never on a first install, only when the worker is more than 10 minutes newer than the page". It is checked before and after the awaited read of the worker's build time, so two signals waiting at once still tell once
- [x] **There were no tests of this**, so `sw-manager.spec.ts` (25) was written: the parsing and guards, the message channel (answer, wrong answer, 1 s timeout, a worker that throws), every branch of the notifier (first install, ≤ 10 min, no build time on either side, build time from the message, once however many signals, two waiting at once), and `startServiceWorker` (errors to Sentry, a newer version announced, nothing listened to outside production)
- [x] Docs: `frontend/index.md`

### Found, not changed

The user-agent reading records what the server stores in `browser_name` / `os_name` / `device_type`, and it has two quirks that are now pinned by `push-device.spec.ts`:

- **An Android phone is recorded as `Linux`** (its user agent contains "Linux", tested before "Android"), and **an iPhone as `macOS`** with version `Unknown` ("like Mac OS X", tested before "iPhone")
- `getStorageFileUrl` adds the dynamic prefix first, on the source as given, so a source that already starts with the root prefix but not the dynamic one gets both again

Both are bugs in data that is stored; fixing them changes what the admin sees (K3 already left the contract with the owner). They are said here so the decision is informed

### Left for the next PRs of phase J

- [ ] `MenuButton.vue` → `PwaInstallButton.vue`
- [ ] playground `TestForm.vue` → `useLoadTest()`, shared helpers with `TestFormWs.vue`, no `any`

## Evidence of Completion

| Check                                      | Result                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                  |
| `pnpm build`                               | exit 0                                                                  |
| `pnpm test`                                | frontend 330 (+25), backend 1731, shared 24, api-playground 26, docs 26 |
| Playwright `mock` project                  | 61 passed                                                               |
| `docs:build && docs:verify`                | passed                                                                  |
