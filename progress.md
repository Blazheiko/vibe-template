# feat-101 — Session Layer Cleanup

Plan: `docs/plan/session-layer-cleanup-plan.md`. Branch: `fix/feat-101-session-cleanup` (from `main` at `197ce02`).

## Current State

- [x] Commit 1 — logout-all: `destroyAllSessions(userToken)` returns `{ deleted, complete }`, no cursor, no `keepSessionId`; `RequestSession.logoutAll` issues the anonymous session in `finally`; `authService.logoutAll` answers 200 after a successful rotation whatever the cleanup does; `Session.destroyAllSessions` removed; every mock migrated; docs + ADR 0002 note.
- [ ] Commit 2 — anonymous stored cookie TTL (`ttlFor`)
- [ ] Commit 3 — remove `session_api`
- [ ] Commit 4 — `destroySession()` signature, `safeEqual` for OAuth state, `index.ts` comment

## Evidence of Completion

(filled in as commits land)

## Notes for Next Session

- `test:pg` is run by CI (`test-pg`); locally there is no disposable database.
