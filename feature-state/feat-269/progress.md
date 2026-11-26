# feat-269 · Branded Types Docs And Skill Fixes

Branch: `docs/branded-types-examples`. Status: implementation done, PR open.

## Scope

The examples that teach the branded types (ADR 0007) must compile. Source: code review of feat-262…feat-268.

## Changes

- `documentation/{,en/}backend/adding-a-feature.md`: Step 9 spec uses `uid(7)` from `src/test-support/ids.ts` instead of `7n`; the file table lists `database/ids.ts` and `app/domain/ids.ts` (the latter only with `parseNoteId`).
- `.claude/skills/backend-feature/SKILL.md`: service takes `SessionToken | undefined`, the controller passes `presentedSessionTokenOf(context.auth.getPresentedUserToken())` (feat-265); the WS controller brands `userData.userId` with `asUserId`; Step 10 names `uid()` / `eid()` for branded ids in tests.
- `.claude/skills/backend-feature/evals/evals.json`: `parseEntityId` (removed) → per-brand constructors.
- `documentation/{,en/}backend/controllers.md`: `requireUserId` returns `UserId`; `getUserId()` / WS `userId` rows and the support chat example lose `BigInt(userId)`; `params` ids go through brand constructors.
- `documentation/{,en/}backend/auth.md`: `getUserId()` row and the "Checking who makes the request" example follow the real `account-controller` (`requireUserId` + service + `respond`).
- `documentation/{,en/}backend/architecture.md`: `findById(asUserId(userId))`, as in `main-service.ts`.
- Found beyond the review: `documentation/{,en/}index.md` (`uploadAvatar(7n, …)`) and `documentation/{,en/}backend/services.md` (`getSubscriptions(7n)`) → `uid(7)`.

## Evidence of Completion

- Tutorial spec compiles: Step 9 of the EN tutorial was written into `packages/backend/src/app/services/note/note-service.spec.ts` next to a stub `note-service.ts` with the tutorial's signatures; `tsc --noEmit -p packages/backend` reported no error in those files. Control: the same check with `getNotes(7n)` fails with `TS2345: Argument of type 'bigint' is not assignable to parameter of type 'UserId'`. Both temporary files were removed.
- `pnpm docs:build && pnpm docs:verify`: `verify-dist: all checks passed`.
- `make check`: exit 0 (backend 3899, frontend 1029, landing 103, api-playground 115 tests passed).
- Baseline `./init.sh` (before changes) failed once on `src/vendor/start/upload-limits.transport.spec.ts` ("does not buffer 20 parallel 50 MiB uploads", got a status line outside 400/413/429) under full-suite load; the file passed 3/3 runs alone and in the later full `make check`. Load-dependent flake, not related to this docs change.
- PG / Redis / e2e suites: not applicable (no code change).
- Manual golden path: the changed pages render in `docs:build`; the skill and tutorial examples match the current signatures (`withCurrentSession`, `presentedSessionTokenOf`, `asUserId`, `requireUserId`, `uid`).

## Notes for Next Session

After merge: a "Mark feat-269 done" PR (status `done`, evidence, delete `feature-state/feat-269/`).
