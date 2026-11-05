# feat-131 — IPv6 Zone Id Crash (high)

## State

Done on branch `fix/feat-131-ip-zone-id`; start PR #426. Waiting for CI on the feature PR.

## Changes

- `vendor/utils/network/ip-address.ts`: `normalizeIp` drops an IPv6 zone id (`%…`), refuses an
  empty zone id or one on IPv4, and never throws (the IPv4-mapped check is guarded). `::%1`,
  `fe80::%eth0`, `1::%a` threw `RangeError: NaN cannot be converted to a BigInt`;
  `::ffff:1.2.3.4%x` read as `1.2.3.0`. The defect came with the IPv4-mapped check of feat-121.
- `vendor/utils/network/ws-handlers.ts`: `handleUpgrade` wraps the upgrade; an unexpected error is
  logged (`WebSocket upgrade failed`) and answered 500 while the client is there, never rethrown.
  uWS drops the promise, and with no unhandledRejection listener a rejection stopped the process.
- Docs: `documentation/backend/security.md`.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean
- `pnpm test`: backend 2476, frontend 400, api-playground 62
- Reproduced before the fix with tsx: `normalizeIp('::%1')` threw; after: `'::'`, key `0:0:0:0::/64`.
- Mutation: main `ip-address.ts` → 13 cases fail (zone ids, hostile inputs, getIP chain);
  main `ws-handlers.ts` → the two upgrade-error cases fail.
