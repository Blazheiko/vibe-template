# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** none (feat-070 done)
**Plan:** `docs/plan/code-review-fixes-tasks.md`; next H2 (feat-071, `auth-normalize.ts`)

## Notes for Next Session

1. H2: normalizers are scattered: `auth-service.ts`, `password-reset-service.ts`, `email-verification-service.ts`, `oauth-service.ts`, `db/seed/run-seed.ts`; first pin them with an edge-case table (unicode, spaces, case) against the current copies, then unify
2. Owner decisions pending: `serialize-routes.ts` non-ArkType branches (K1); whether a session revocation should close the user's open WebSockets
