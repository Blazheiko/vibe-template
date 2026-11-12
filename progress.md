# Progress: feat-183 Query Input Types From Schemas

## Current state

Done, in review.

- `QueryInputOf<Schema>` and `QueryWireValue<T>` in `packages/shared/src/schemas/query/types.ts`: keys and optionality come from the schema input (a `.default()` field is optional), and values from the schema output (`number` → `number | string`, `Date` → string, `boolean` → `boolean | 'true' | 'false'`).
- Every `*QueryInput` (admin, usage, support, simple) is now `QueryInputOf<typeof …Schema>`. The hand-written `PaginationQueryInput`, `DateRangeQueryInput`, `BaseUsageQuery` and `BaseUsageQueryInput` are removed; nothing outside `schemas/query` used them.
- `type-checks.ts` has a new `QueryInputChecks` block. It asserts that each derived type is identical to the shape clients were written against, so the derivation itself is under test.
- The registry (`contract-registry.ts`) now checks `Same<QueryInputOf<Q>, QueryOf<C>>` instead of comparing keys only.
- New negative tests in `define-route.spec.ts`:
  - same keys but a different value type;
  - a field that is optional in the schema but required in the contract.

  Before the registry change, both failed as "Unused @ts-expect-error" (RED).
- Docs updated in both locales: `backend/routing.md` and `backend/validation.md`, plus ADR 0005.

## Evidence of Completion

- `make check` (format, typecheck, lint, test): passing. shared 30, documentation 26, api-playground 113, frontend 515, backend 2680.
- `pnpm docs:build && pnpm docs:verify`: passing.
- Manual check: types only, with no runtime change. Under the old registry the new `@ts-expect-error` lines were reported as unused; under the new one they are needed.
- e2e: not run locally, because there is no runtime change (types only). CI runs e2e and e2e-live.

## Notes for Next Session

Next is feat-184, the shared WS envelope type.
