# feat-116 — Storage Object Replacement

Plan: `docs/plan/code-review-2026-11-03-plan.md`, item R11d (findings 24, 25; after feat-114). Branch: `fix/feat-116-storage-object-replacement` (from `main` after #380).

## Current State

Implemented; PR open.

- Repositories:
    - `userRepository.replaceAvatarIfSessionToken(id, token, avatar | null)`: in a transaction, `SELECT avatar … FOR UPDATE` (only while the session token is current), UPDATE, and return `{ user, previousAvatar }`.
    - `supportKnowledgeRepository.replaceScreenshot(id, { key, mime } | null)`: same pattern, returns `{ previousKey }`; it replaces `setScreenshot` / `clearScreenshot` (removed) and leaves `content_version` as is.
    - `supportKnowledgeRepository.delete` returns the screenshot key from `DELETE … RETURNING`.
- Services (`avatar-service.ts`, `knowledge-base-service.ts`):
    - upload the new object, swap the key, delete the key the swap returned;
    - a thrown or refused swap deletes the new object (user gone or session revoked → 401; article gone → 404);
    - removal and article delete delete the key returned by their own statement.
- Docs: `storage.md` (order + diagram), `auth.md`, `repositories.md`.

## Files Modified

- `packages/backend/src/app/repositories/user/user-repository.ts`, `src/app/repositories/support/support-knowledge-repository.ts`
- `packages/backend/src/app/services/user/avatar-service.ts`, `src/app/services/support/knowledge-base-service.ts` + specs (`avatar-service.spec.ts`, `knowledge-base-service.spec.ts`, `avatar-controller.spec.ts`), `kb-embedding-consistency.pg.test.ts` (uses `replaceScreenshot`)
- New: `packages/backend/src/app/services/storage-object-replacement.pg.test.ts`
- Docs as above.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 2340, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` with Redis: 27 files / 236 passed. `test:redis`: 11 files / 107 passed.
- `storage-object-replacement.pg.test.ts` (real PostgreSQL, in-memory S3; uploads held so the race is chosen):
    - KB:
        - two parallel uploads → one object, the row's;
        - S3 upload failure → old row and object unchanged;
        - DB failure after upload → new object deleted, old kept;
        - a removal that read the old key before an upload finished → row null, no object left;
        - article deleted during an upload → no object left.
    - Avatar: two parallel uploads, DB failure after upload, and removal racing an upload, with the same results.
- Unit specs:
    - the deleted avatar key is the one the swap returned, not the one read before;
    - a thrown swap deletes the new object;
    - the KB upload happens before the swap.
- Mutation check:
    - `main`'s services and KB repository fail all 8 PG cases;
    - deleting the avatar key read before the upload (instead of the swapped one) fails the parallel-upload case.
- Manual: the built backend starts, `/api/ready` returns 200, `DELETE /api/avatar` without a session answers 401, and SIGTERM exits 0.
    - No real upload was made: `S3_ENDPOINT` in the local `.env` points to an external store, not a local MinIO, so the S3 paths are covered by the in-memory S3 in the PG test.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next by the plan order: R12a (needs decision Д4), R12b (LLM usage status, migration, ADR 0003).
