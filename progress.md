# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-076 - Frontend Component Split (in progress, phase J, part 2)
**Branch:** `refactor/frontend-split-components-2` (part 1, `AuthModals.vue`, is merged as #260)
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase J

## Status

### Done in this PR (item 2 of phase J: `stores/state.ts`)

`stores/state.ts` held three things; it was 559 lines, now 126 (theme, font, colour theme, PWA mode, window size, storage config):

- [x] **`stores/push.ts`** (`usePushStore`): the notification permission, this browser's subscription, its id on the server, subscribing, unsubscribing, loading what the server knows (with the 60 s resource), and the reset on sign-out. Consumers moved: `UserAccount.vue`, `useSessionLifecycle.ts`; `UserAccount.spec.ts` mocks the new store
- [x] **`utils/push-device.ts`**: the user-agent reading (`getDeviceType`, `getBrowserInfo`, `getOSInfo`) and the key helpers (`urlBase64ToUint8Array`, `arrayBufferToBase64`, `isValidVapidKey`), as pure functions of a user-agent string. The code is the old code moved
- [x] **`utils/storage-url.ts`**: `getStorageFileUrl(config, src)` and `StorageConfig`; `avatar-url.ts` calls it with the store's config. Checked against the old method before it was removed: 55 combinations of 5 configurations and 11 sources gave identical answers
- [x] **There were no tests of any of this**, so they were written: `storage-url.spec.ts` (5), `push-device.spec.ts` (16), `push.spec.ts` (11: permission, subscribing with an existing subscription and with a server key, a missing key, unsubscribing, the reset, what the server already knows, the window of the resource)
- [x] Docs: `frontend/index.md`, `backend/storage.md`, `backend/web-push-notification.md`

### Found, not changed

The user-agent reading records what the server stores in `browser_name` / `os_name` / `device_type`, and it has two quirks that are now pinned by `push-device.spec.ts`:

- **An Android phone is recorded as `Linux`** (its user agent contains "Linux", tested before "Android"), and **an iPhone as `macOS`** with version `Unknown` ("like Mac OS X", tested before "iPhone")
- `getStorageFileUrl` adds the dynamic prefix first, on the source as given, so a source that already starts with the root prefix but not the dynamic one gets both again

Both are bugs in data that is stored; fixing them changes what the admin sees (K3 already left the contract with the owner). They are said here so the decision is informed

### Left for the next PRs of phase J

- [ ] `main.ts` 48–401 → `utils/sw-manager.ts` with one `shouldNotify()`
- [ ] `MenuButton.vue` → `PwaInstallButton.vue`
- [ ] playground `TestForm.vue` → `useLoadTest()`, shared helpers with `TestFormWs.vue`, no `any`

## Evidence of Completion

| Check                                      | Result                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                  |
| `pnpm build`                               | exit 0                                                                  |
| `pnpm test`                                | frontend 305 (+32), backend 1731, shared 24, api-playground 26, docs 26 |
| Playwright `mock` project                  | 61 passed                                                               |
| `docs:build && docs:verify`                | passed                                                                  |
