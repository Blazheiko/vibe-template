# feat-279 · Header keyboard navigation and i18n

Tasks T8–T12 of [docs/plan/frontend-tasks.md](../../docs/plan/frontend-tasks.md). Branch `feat/fe-header-keyboard`, owner Blazheiko.

## State

All tasks T8–T12 done; ready for review.

## Baseline (T8)

`make check` on `d8ed47f3` (main after #911) in the worktree: exit 0.

## Changes

- **T9.** Locale sections `menu` and `header` (en/uk/pl). `MenuButton.vue`: every item, group header and the logout text from i18n; hamburger with `aria-label` (`menu.open`/`menu.close` by state), `aria-expanded`, `aria-controls` (the dropdown's `useId()`), `aria-haspopup`. `AppHeader.vue`: Back with `aria-label` (its `<span>` is `display: none` on phones) and `type="button"`, Support and the WebSocket status and its title from i18n. `PwaInstallButton.vue`: `menu.installApp`. The English texts are unchanged, so existing selectors (`Sign In`, `.logout-item`, `Connected` in e2e-live) still match.
- **T10.** Escape closes the open menu and returns the focus to the hamburger; opening moves the focus to the first item. The dropdown's `visibility` now switches at once on open (the fade stays): with `visibility` in the 0.3 s transition, the first item could not take the focus right after opening.
- **T11.** Collapsed `.group-items` are `inert`; group headers carry `aria-expanded` and `aria-controls`.
- **T12.** `e2e/mock/header-keyboard.spec.ts` (phone viewport): names of Back (text hidden) and the hamburger, Escape and the focus, Tab past collapsed sections and into an expanded one, Ukrainian texts. `PwaInstallButton.spec.ts` mounts with i18n and checks the Ukrainian text.

## Evidence of Completion

- `make check`: exit 0 after merging `main` with feat-278 (frontend 1050 tests, backend 3989; `check-cold-start-budget: /login max 280.6 KB (uk)`, +0.5 KB for the new strings).
- `pnpm --filter frontend test:e2e`: 138 passed (134 + 4 new), before and after merging `main`.
- `header-keyboard.spec.ts --repeat-each 3`: 12 passed.
- Golden path (mock e2e, phone viewport): sign-in state → /notifications → open the menu, move by Tab, Escape back to the hamburger; the same in Ukrainian.

## Notes for Next Session

- Next feature for this owner: `feat-280` (lazy Sentry SDK).
