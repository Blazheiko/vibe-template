# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-076 - Frontend Component Split (in progress, phase J, part 1)
**Branch:** `refactor/frontend-split-components`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase J

## Status

### Done in this PR (item 1 of phase J: `AuthModals.vue`)

`AuthModals.vue` was 1709 lines (a 715-line script, 500 of template, 490 of styles). Its props, emits and DOM are unchanged (`Login.vue` mounts it as before):

- [x] `components/auth/AuthModalShell.vue`: the overlay, panel, title and close button, written once for both modals; its styles are the shell's own (scoped)
- [x] `LoginForm.vue`: the sign-in step. The typed identifier and password stay with `AuthModals.vue` (`v-model`), because the forgot-password step starts from the identifier and coming back must not lose either
- [x] `ForgotPasswordFlow.vue`: ask for the reset link, or for a phone number the SMS code and the new password. Its step (`email` / `phone` / `sent`) is a `v-model` because the modal's title follows it
- [x] `RegisterEmailForm.vue` and `RegisterPhoneFlow.vue` (the three steps, with their own back links); the choice step stays in `AuthModals.vue`
- [x] `composables/useAuthRequest.ts` replaces the seven `try / catch / finally` (loading on, run, "server error" and a log line when it throws, loading off) and the five copies of "an error answer → its message"; `composables/useCompleteSignIn.ts` replaces the three copies of "remember the user, announce, open the account page, re-read the session", in that order; `utils/auth-identifiers.ts`, `utils/phone-auth.ts`
- [x] **Styles.** The forms' rules (`.form-group`, inputs, `.auth-button`, the checkbox, …) are shared by all the steps, so they moved to `assets/auth-forms.css`, unscoped but every rule under `.auth-modal`, with the specificity they had (`.dark-theme` rules included). 1709 → 203 lines in `AuthModals.vue`
- [x] **A step now starts afresh by remounting** (`:key` bumped when a modal is opened, closed or switched), instead of a 30-line `clearLoginState` / `clearRegisterState` resetting 40 refs

### Differences from before, all small

- Two registration paths used to share one set of fields (name, password, terms), so a name typed in the e-mail form showed up in the phone form's last step; each form now has its own. Nothing in the 61 mock tests or the unit specs depended on it
- `registerChoiceError`, an error block of the choice step that nothing ever set, is gone

### Evidence that nothing visible changed

- **Pixel comparison, 28 states** (14 × light and dark; login, login with validation errors, login after a 401, forgot by e-mail, forgot by phone with its errors, back to sign-in, register choice, e-mail form with and without errors, phone start, confirm, complete with errors), a throwaway Playwright spec on the `mock` build with a fixed viewport, time zone and data and the mouse parked: the old component produced the same screenshots on two runs, and the split one is **identical to the pixel in all 28**
- The 61 Playwright `mock` tests (G2) pass unchanged, and the 6 `AuthModals.spec.ts` unit tests
- `auth-composables.spec.ts` (4) pins the two composables

### Left for the next PRs of phase J

- [ ] `stores/state.ts` → `stores/push.ts`, `utils/storage-url.ts`, UI prefs apart
- [ ] `main.ts` 48–401 → `utils/sw-manager.ts` with one `shouldNotify()`
- [ ] `MenuButton.vue` → `PwaInstallButton.vue`
- [ ] playground `TestForm.vue` → `useLoadTest()`, shared helpers with `TestFormWs.vue`, no `any`

## Evidence of Completion

| Check                                      | Result                                                            |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                            |
| `pnpm build`                               | exit 0                                                            |
| `pnpm test`                                | frontend 273, backend 1731, shared 24, api-playground 26, docs 26 |
| Playwright `mock` project                  | 61 passed, unchanged                                              |
| Pixel comparison of the auth modals        | 28 states identical                                               |
| `docs:build && docs:verify`                | passed                                                            |
