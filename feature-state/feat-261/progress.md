# feat-261 progress: Implemented Features Page

## State
Documentation only. Added `documentation/reference/implemented-features.md` (uk) and `documentation/en/reference/implemented-features.md` (en): account scenarios with status, feat id and doc page; the admin area (pages, permissions, API-only features, roles). Sidebar of both locales, `KEY_PAGES` and `EN_KEY_PAGES`, and a pointer in both `index.md` files.

Statuses come from `origin/main:feature_list.json` and the code (admin pages in `admin-pages.ts`, jobs in `scheduler/jobs/index.ts`, no export/delete-account/metrics code found by grep).

## Files modified
- documentation/reference/implemented-features.md, documentation/en/reference/implemented-features.md (new)
- documentation/.vitepress/config.ts, documentation/scripts/verify-dist.mjs, documentation/index.md, documentation/en/index.md

## Evidence of Completion
- `make check`: exit 0 (backend 3742 tests passed).
- `pnpm docs:build && pnpm docs:verify`: build complete, "verify-dist: all checks passed".
- Anchors used by the new links checked in dist HTML (8 of 8 present).
- No PG/Redis/UI code touched, so test-pg, test-redis and e2e are not applicable.

## Notes for Next Session
Mark feat-261 `review`, then a "Mark feat-261 done" PR after the merge.
