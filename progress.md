# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-075 - Frontend And Shared Dedup (in progress, phase I: the last part)
**Branch:** `refactor/frontend-shared-dedup-4` (parts 1-3 are merged as #255, #256, #257)
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase I

## Status

### Done in this PR (item 6 of phase I: the admin views)

- [x] **`buildAdminQuery` → `utils/admin-query.ts`** (`adminQueryString`): the three copies of "build the query string of an admin list" (users, online history, knowledge base) are one function: undefined and empty values are left out (zero is not), keys keep their order, values are encoded. `api.ts` passes the same keys in the same order, with the user id trimmed first as before. `admin-query.spec.ts` (7) pins the URLs of the three requests; the four that describe the old behaviour **pass on the old `api.ts` too**
- [x] **`encodeURIComponent` on the id** of `admin/users-online/<id>` (the one missing: the plan's `:546`). The only deliberate behaviour change in `api.ts`; ids are numeric, so nothing visible changes, but an id with `/` or `?` can no longer rewrite the path
- [x] **`useAdminUserDetailModal()`** (`composables/`): the open/load/close of the user-details modal was identical in `AdminUsersView`, `AdminUserOnlineView` and `AdminHistoryOnlineView` (≈ 30 lines each); one composable, three one-line uses
- [x] **`AdminFilterBar.vue`** (`components/admin/`): the user-id + date-range card with Apply / Reset, used by the users and the history views (`v-model`, `from-label`, `to-label`, `loading`, `busy`, `submit`, `reset`); its styles live in the component. The History view keeps its own `.btn` rules, because its "Load more" button uses them
- [x] **`assets/admin.css`**: the table helpers three views repeated (`.table-wrap`, `.cell-id`, `.cell-email`, `.cell-empty`, `.empty-row`), scoped under `.admin-content` so nothing outside the admin panel is touched; included by `AdminLayout.vue`
- [x] **Screenshots before and after**, pixel-compared with Playwright on the `mock` build (a throwaway spec with a fixed viewport, time zone and data, 5 pages: users, history, user online, knowledge base, and the users page with the detail modal open; not committed). History, User Online and Knowledge Base: **identical, 0 pixels**. Users: the filter buttons are now the History view's style (8 px radius, 8 px padding, 0.875 rem, hover state) instead of its own slightly smaller ones, and the table below sits about 2 px lower; 2960 pixels differ, all in the buttons and the shifted table text (the diff image was looked at). That is the one visible change; the two views had drifted apart and are now one
- [x] Docs: `frontend/index.md`

### Phase I as a whole

All eight items are done or explicitly settled: password limits, phone shape, entity id, event bus, `shared/ws-client` (what is the same code), `sanitizeTree`, ArkType `.default()`, admin views. **Not done, on purpose and said in the PRs:** the WebSocket connection core in shared (the two connections are different things), and the second pass over breadcrumbs at send (kept: defence in depth)

## Evidence of Completion

| Check                                      | Result                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                       |
| `pnpm build`                               | exit 0                                                                       |
| `pnpm test`                                | frontend 269, backend 1731, shared 24, api-playground 26, docs 26            |
| Playwright `mock` project                  | 61 passed                                                                    |
| Admin screenshots, before / after          | 3 of 4 pages identical; Users: filter buttons and the 2 px shift (see above) |
| `docs:build && docs:verify`                | passed                                                                       |

## Notes for Next Session

1. Merge this PR; then a PR flipping feat-075 to `done` and starting feat-076 (phase J, split of the big components: `AuthModals.vue` first; G2's 61 mock tests are its net)
