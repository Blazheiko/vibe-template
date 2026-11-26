# feat-268: Shared And Frontend Brands — progress

## Current state

Implementation complete (T43–T48 of `docs/plan/branded-types-tasks.md`); waiting for CI and review.

## What changed

- `shared/brand`: wire brand types `EntityId`, `IsoDateTime`, `Cursor`, `SessionPublicId` and
  `toIsoDateTime` / `toIsoDateTimeOrNull`. `shared/brands/wire.ts`: `IsoDateTimeSchema`
  (`string.date.iso`), `CursorSchema`, `SessionPublicIdSchema` (moved from `responses`);
  `type-checks.ts` asserts each equals its `shared/brand` twin.
- Response schemas (T44): row ids and `userId` / `subscriptionId` are `EntityIdSchema`, camelCase `*At` fields (and `recovery.expiresAt`) `IsoDateTimeSchema`,
  `nextCursor` `CursorSchema`, the session id `SessionPublicIdSchema`. Not branded: audit `target.id` (a prompt is named by its type), the passkey
  credential descriptor id, `uuid`, `challengeId`, `enrollmentId`, `requestId`, snake-case
  `created_at` / `updated_at`.
- `BroadcastPayload` is the schema's output (`infer`), so WS payload ids are `EntityId` on both sides.
- `QueryWireValue` strips a brand (option of Р8); a type check in `schemas/query/type-checks.ts`
  fails if it does not.
- Backend: `toEntityId` returns `EntityId`; transformers and services brand through
  `toEntityId` / `toIsoDateTime`; text from trusted sources through the new
  `app/domain/wire.ts` (`asIsoDateTime`, `isoDateTimeOfPgText` (was `occurredAtIso`), `asCursor`,
  `asSessionPublicId`). The admin remove broadcast parses the vendor user id.
- Frontend (T45): `stores/user.ts` `User = AuthUser` from `shared` (index signature removed),
  `stores/push.ts` picks from `SerializedPushSubscription`, `ws-payload-guards.ts` narrows ids to
  `EntityId`, optimistic values use `toIsoDateTime`; a support message keeps `id: string` for
  local ids. `no-brand-cast` runs in `packages/frontend/eslint.config.ts` (verified on a probe file).
- Tests (T46): `src/__tests__/brands.ts` with `asEntityId`, `asIsoDateTime`, `asSessionPublicId`,
  `asCursor`, `testUser`; the typed factories (`ActiveSessions`, `AdminUsersView`,
  `AdminAuditLogView`, `preferences`) and `setUser` calls use them. Untyped mock literals did not
  need a change. Backend `test-support/ids.ts` gains `eid()`.
- Р9 (T47): `PriceInCents` removed; `shared/test/primitives.test.js` accepts/rejects
  `PositiveInt`, `NonNegativeInt`, `NonEmptyString`, `IsoDateTime`, `SessionPublicId`.
- Docs: transformers, adding-a-feature (uk + en), shared/index (uk + en), `backend-feature`
  skill, ADR 0007 consequence.

## Evidence of Completion

- First CI run: `test-pg` and `e2e-live` failed on the audit log (500): `entityIdOfText` threw on
  `target_id = 'SUPPORT_FIRST_CHAT'`. Fixed by keeping `target.id` a string; full PG suite locally
  (pgvector:pg16 + redis:7): 72 files / 724 passed, 0 skipped.
- `make check`: exit 0 — backend 3899 passed, frontend 1029, landing 103, api-playground 115,
  shared and eslint-rule tests pass.
- `pnpm --filter frontend test:e2e`: 134 passed.
- `pnpm docs:build && pnpm docs:verify`: all checks passed.
- CI `test-pg` / `test-redis` / `e2e-live`: to be recorded from the PR run (the response check now
  validates ISO dates, so `test-pg` covers the real responses).
- Golden path: sessions, notifications and admin pages are covered by the e2e suite above and by
  `e2e-live` in CI; no manual browser session was run.

## Notes for Next Session

Record the CI counts, set `review`, merge, then the "Mark feat-268 done" PR. This closes the
branded-types plan (feat-262…268).
