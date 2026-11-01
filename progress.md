# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-075 - Frontend And Shared Dedup (in progress, phase I)
**Branch:** `refactor/frontend-shared-dedup-2` (part 2; part 1 is merged as #255)
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase I

## Status

### Done in this PR (items 7 and 8 of phase I)

- [x] **Sentry `sanitizeTree`.** `sanitizeRequestData` and `sanitizeBreadcrumbData` were one walker written twice; they differ only in what a sensitive key becomes, so it is `sanitizeTree(value, 'drop' | 'filter')`: dropped from request data, kept as `[Filtered]` in breadcrumbs. The extra `authorization|cookie` test of the breadcrumb walker was already covered by `SENSITIVE_KEY_RE` (it matches `auth` and `cookie`). A new spec (arrays, nesting, `null`, numbers, URL-like keys, both modes) passes **on the old code and on the new**
- [x] **The second pass at send is kept, against the plan.** The plan asks to remove the re-run of the breadcrumb filter in `beforeSend`. It is idempotent and cheap, the breadcrumbs of an event can come from paths that skipped the `beforeBreadcrumb` hook, and this is a privacy filter: defence in depth is worth a few microseconds. The new spec pins it
- [x] **ArkType `.default()`.** The installed `@arktype/type` 2.2.9 types and runs `.default('50')` correctly (checked: `inferIn` has the key optional, `infer` has the number, `{}` parses to the defaults, `'0'` is refused). So the tuple-default casts (`[x, '=', '50'] as unknown as 'string.integer.parse'`) and the outer `as unknown as SharedQuerySchema<…>` casts are gone from `query/common.ts`, `admin.ts`, `usage.ts`, `support.ts`; `SharedQuerySchema` and the hand-written `*QueryOutput` interfaces went with them
- [x] **What the schemas infer is still pinned**, now at compile time: `query/type-checks.ts` compares `typeof Schema.infer` with the written-out output type of each of the five schemas (`AssertEqual`/`Expect`); a deliberate mismatch was checked to stop the build. And at run time: `contracts.test.js` checks defaults, string → number/Date parsing and refusals for the four admin/usage schemas; it passes on the old implementation too, so nothing changed
- [x] Docs: `backend/validation.md`

### Left for the next PRs of phase I

- [ ] WS transport into `shared/ws-client` (the biggest)
- [ ] `event-bus.ts` (frontend uses mitt, the playground a hand-rolled copy; the playground has no `mitt` dependency)
- [ ] Admin views: `useAdminUserDetailModal`, `AdminFilterBar.vue`, `buildAdminQuery()` + `encodeURIComponent`, shared `admin.css` (screenshots before and after)

## Evidence of Completion

| Check                                      | Result                                                            |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                            |
| `pnpm build`                               | exit 0                                                            |
| `pnpm test`                                | shared 20, frontend 262, backend 1731, api-playground 29, docs 26 |
| New specs on the old implementation        | pass (sentry spec; query defaults)                                |
| `docs:build && docs:verify`                | passed                                                            |
