# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-076 - Frontend Component Split (in progress, phase J, part 4)
**Branch:** `refactor/frontend-split-components-4` (merged: part 1 `AuthModals.vue` #260, part 2 `stores/state.ts` #261, part 3 service worker #262)
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase J

## Status

### Done in this PR (item 4 of phase J: `MenuButton.vue`)

`MenuButton.vue` was 752 lines, 140 of them the install logic; it is now 634 and keeps only the menu:

- [x] **`composables/usePwaInstallButton.ts`**: the element ref, "is the install offered" (`resolveInstallAvailable`, a pure function: installed → no; browser prompt ready → yes; Chromium without a prompt yet → no, the element is not believed; no native prompt (Safari) → the element decides), the theme colours for the dialog, `installApp` (runs a `beforeInstall` callback — the menu closes — then the native prompt, else the dialog of the element) and the listeners on the element
- [x] **`components/PwaInstallButton.vue`**: the item itself, one `<button class="menu-item install-app">` emitting `install`. It is a single root, so the menu's scoped styles still reach it (checked: the button carries the menu's `data-v-` id). The `<pwa-install>` element stays in `MenuButton.vue` on purpose: the dropdown has a `transform`, which would turn the element's `position: fixed` dialog into one placed inside the dropdown
- [x] **A small fix on the way**: the old `onUnmounted` removed the listeners through `pwaInstall.value`, which Vue has already set to `null` by then, so it never removed anything. The composable remembers the element it listened to. Harmless in practice (the element goes with the component), now correct and tested
- [x] Tests: `usePwaInstallButton.spec.ts` (13: the decision table, offer/stop, installed app, click order close → prompt, dialog fallback, element events, the prompt handed to the element, theme styles, listener removal) and `PwaInstallButton.spec.ts` (1)
- [x] Docs: `frontend/index.md`

### Found, not changed

The user-agent reading records what the server stores in `browser_name` / `os_name` / `device_type`, and it has two quirks that are now pinned by `push-device.spec.ts`:

- **An Android phone is recorded as `Linux`** (its user agent contains "Linux", tested before "Android"), and **an iPhone as `macOS`** with version `Unknown` ("like Mac OS X", tested before "iPhone")
- `getStorageFileUrl` adds the dynamic prefix first, on the source as given, so a source that already starts with the root prefix but not the dynamic one gets both again

Both are bugs in data that is stored; fixing them changes what the admin sees (K3 already left the contract with the owner). They are said here so the decision is informed

### Left for the next PRs of phase J

- [ ] playground `TestForm.vue` → `useLoadTest()`, shared helpers with `TestFormWs.vue`, no `any`

## Evidence of Completion

| Check                                      | Result                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                  |
| `pnpm build`                               | exit 0                                                                  |
| `pnpm test`                                | frontend 344 (+14), backend 1731, shared 24, api-playground 26, docs 26 |
| Playwright `mock` project                  | 61 passed                                                               |
| `docs:build && docs:verify`                | passed                                                                  |
