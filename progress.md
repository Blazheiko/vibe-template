# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** none (feat-069 done)
**Plan:** `docs/plan/code-review-fixes-tasks.md`; next phase H (H1–H5, feat-070…074; H1 also depends on feat-077/K1)

## Notes for Next Session

1. Phase G is merged (PRs #231, #232, #233). The tables in `packages/backend/src/app/services/auth/*contract*.spec.ts`, the mail snapshots and `e2e/mock`, `e2e-live` are the net for H and J: they must not change a row
2. H1 depends on feat-077 (K1) which is not started; check `feature_list.json` dependencies before starting
3. Open question for J: after a successful sign-in the page is now and then left on `/` instead of `/account` (see the G3 notes in git history of `progress.md`)
