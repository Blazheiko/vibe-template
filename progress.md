# feat-135 — Lease, S3 and KB Lows (sixth review I2)

## State

Done on branch `fix/feat-135-lease-s3-kb`. Waiting for CI on the feature PR.

## Changes

- **L4** `redis-lease.ts`: `Lease.stopBeforeExpiryMs`; `lost` fires `max(renewEveryMs,
stopBeforeExpiryMs)` before the key can expire. `leaseForDatabaseWrites` sets it to the longest
  write on the main pool (`DATABASE_WRITE_BOUND_MS` = connect wait 2 s + `DB_QUERY_TIMEOUT_MS` +
  500 ms grace) + 1 s, and grows the TTL so two renewals still fit. The KB init and the support
  answer leases use it (with defaults: told lost 13.5 s before expiry instead of 10 s / 5 s). The
  pool constants (`QUERY_TIMEOUT_GRACE_MS`, `POOL_CONNECTION_TIMEOUT_MS`, `statementBoundMs`) moved to
  `config/database-pool.ts`, the one source for `db.ts` and the lease.
- **L5** `db-errors.ts`: `isServerRejection` needs a SQLSTATE-shaped code **and** a string
  `severity` (every PostgreSQL ErrorResponse has it); Node errno codes (`EPIPE`, `EPERM`) no
  longer pass.
- **L9** `knowledge-base-init-service.ts`: when the re-read after an unanswered INSERT fails too,
  the status says the count is unknown and still points to reindex-all.
- Docs: `ai.md`, `storage.md`.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean
- `pnpm test`: backend 2521, frontend 400, api-playground 62; docs build + verify
- local test:pg 173 passed (Redis files by CI)
- Mutation: main `redis-lease.ts`, `db-errors.ts`, `knowledge-base-init-service.ts` → 6 new cases
  fail (lease margin 2, Node errno / no severity 3, KB status 1).
