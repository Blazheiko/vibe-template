# feat-130 — Operations Lows (fifth review H4)

## State

Done on branch `fix/feat-130-operations-lows`; start PR #423. Waiting for CI on the feature PR.
This is the last group of the fifth review.

## Changes

1. Purge (`llm-usage-repository.ts`): the table is paged by id (`id > last ORDER BY id LIMIT n`) and
   the UPDATE, or the dry-run count, covers that page only. No statement scans the whole table, even
   when nothing is left to purge.
2. Push endpoint (`push-endpoint-policy.ts`): RFC 3986 §6.2.2 percent-encoding normalization of path
   and query (`%41` → `A`, `%3d` → `%3D`). A different query stays a different endpoint (WNS keeps
   its token in the query); documented.
3. S3 swap (`avatar-service.ts`, `knowledge-base-service.ts`, `db-errors.ts`): after a thrown swap
   the new object is deleted only when PostgreSQL answered with an error (`isServerRejection`:
   SQLSTATE on the error or its cause, so the transaction rolled back). Without an answer the object
   is kept with a warning. The re-read on another connection could not see a COMMIT still in flight.
4. OAuth (`oauth-service.ts`): arctic's code exchange races `OAUTH_PROVIDER_TIMEOUT_MS`.
5. Lease (`redis-lease.ts`): `release()` marks the lease released; a renewal that answers later
   does not re-arm the deadline (no false "lost").
6. CIDR (`ip-address.ts`): an IPv4-mapped CIDR (`::ffff:a00:0/104`) is the IPv4 network with prefix
   − 96; shorter than /96 matches nothing.
7. KB init (`knowledge-base-init-service.ts`): an article INSERT error without SQLSTATE re-reads the
   article count; if articles are there, the status is failed with `createdArticles` = that count and
   a pointer to reindex-all.
8. XFF (`get-ip.ts`): every `X-Forwarded-For` line is read in order (`req.forEach`), not only the
   first one `getHeader` returns.

Docs: `ai.md`, `oauth.md`, `security.md`, `storage.md`, `web-push-notification.md`.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean
- `pnpm test`: backend 2439, frontend 400, api-playground 62
- `pnpm docs:build && pnpm docs:verify` pass
- test:pg on local PostgreSQL 17 (no Redis): 171 passed, 86 skipped (Redis files). One
  failure, `readiness-probe.pg.test.ts` "a statement that does not answer", fails the same way on
  main locally (environment of the local server); CI runs it.
- Mutation (main version of each source file, new tests): lease 1, CIDR 5, XFF 2, push endpoint 6,
  KB init 1, avatar unit 1, OAuth exchange 4, purge PG 1, S3 swap PG 2 fail.

## Notes for Next Session

The fifth review is closed with this feature. Next step: a re-review of feat-127…130 if wanted.
