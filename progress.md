# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-076 - Frontend Component Split (in progress, phase J, part 5)
**Branch:** `refactor/frontend-split-components-5` (merged: part 1 `AuthModals.vue` #260, part 2 `stores/state.ts` #261, part 3 service worker #262, part 4 `MenuButton.vue` #263)
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase J

## Status

### Done in this PR (item 5 of phase J: api-playground `TestForm.vue`)

`TestForm.vue` was 859 lines with an `any` for its result; it is now 558 and has no `any`:

- [x] **`composables/useLoadTest.ts`**: `useLoadTest({ requestCount, threadCount, send?, onSingleResponse? })` → `testResult`, `isLoading`, `progress`, `progressPercentage`, `run(spec)`, `clear()`. One request, many on one thread, or many on several; the bar lingers 1 s after a run. The client is injectable, so it is tested without a network
- [x] **`utils/load-test.ts`**: the typed shape of what the response pane shows (`TestResult`, `RequestOutcome`, `LoadStatistics`, ...: one interface for the four things it can be, replacing the `any`) and the pure parts: `executeRequest`, `executeThread`, `singleResultOf`, `summaryOf`, `failedRunOf`, `wsHandoffOf`. `SendHttp` is exported from `base-api.ts`
- [x] **`utils/test-form-helpers.ts`**: `scrollToResponse(bodyId, sectionId)` and `formatResponseBody`, now shared with `TestFormWs.vue` (two copies of the same scroll code before)
- [x] **Checked against the old code, not only by new tests**: the old `TestForm.vue` was mounted next to the new one with the same scripted client and fake clock, over 15 scenarios (GET/POST, bad body, bad/empty/`0` headers, one, many, threads, errors, throws, `wsUrl` handoff with and without a token and on an error), comparing the result, progress while running and after the linger, the client's calls, the handoff calls, the displayed body and the errors. All 15 identical; two mutations (the failed count, the default token) turned 3 and 2 of them red. The throwaway (it needed `jsdom`) is deleted and not committed
- [x] Tests: `load-test.spec.ts`, `useLoadTest.spec.ts`, `test-form-helpers.spec.ts` (api-playground 26 → 62)
- [x] Docs: `playground/index.md`

One behaviour differs, on purpose: `buildUrl()` (which throws when a route has no `fullUrl`) is now called before the run starts. Before, it ran after `isLoading` was set and outside the `try`, so the form stayed "loading" for ever

### Found, not changed

The user-agent reading records what the server stores in `browser_name` / `os_name` / `device_type`, and it has two quirks that are now pinned by `push-device.spec.ts`:

- **An Android phone is recorded as `Linux`** (its user agent contains "Linux", tested before "Android"), and **an iPhone as `macOS`** with version `Unknown` ("like Mac OS X", tested before "iPhone")
- `getStorageFileUrl` adds the dynamic prefix first, on the source as given, so a source that already starts with the root prefix but not the dynamic one gets both again

Both are bugs in data that is stored; fixing them changes what the admin sees (K3 already left the contract with the owner). They are said here so the decision is informed

### Left for phase J

None of its items: J's criteria remain (G2/G3 e2e green unchanged, manual golden path), then the "Mark feat-076 done" PR

## Evidence of Completion

| Check                                      | Result                                                            |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                            |
| `pnpm build`                               | exit 0                                                            |
| `pnpm test`                                | frontend 344, backend 1731, shared 24, api-playground 62, docs 26 |
| Playwright `mock` project                  | 61 passed                                                         |
| `docs:build && docs:verify`                | passed                                                            |
