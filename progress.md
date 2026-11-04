# feat-110 — Client IP Keys

Plan: `docs/plan/code-review-2026-11-03-plan.md`, item R07 (findings 6, 9; decisions Д3: IPv6 /64, Д5: explicit unix-socket flag). Branch: `fix/feat-110-client-ip-keys` (from `main` after #362).

## Current State

Implemented; PR open.

- `vendor/utils/network/ip-address.ts` (new):
    - `normalizeIp`, `parseIp`, `isIpInCidr` moved from `get-ip.ts`;
    - `rateLimitKeyForIp(ip)`: IPv4 (and IPv4-mapped IPv6) is the address itself, IPv6 is its canonical `/64` (`2001:db8:1:2::/64`), and anything else is `unknown`.
- Limit keys: `clientKey` (HTTP L1, per-route, WS upgrade, WS messages) uses `rateLimitKeyForIp`, and so does `auth-throttle-service` for `keyBy: 'ip'` policies. The full address still goes to logs, `user_online` and the session.
- `get-ip.ts`: an empty remote address (unix socket) is the client `unknown`, unless the server listens on `APP_UNIX_PATH` **and** `TRUST_UNIX_SOCKET_PROXY=true`. In that case the client is read from `X-Forwarded-For` (right to left, `TRUSTED_PROXY_CIDRS` skipped), then `X-Real-IP`, then `unknown`.
- `config/network.ts`: `TRUST_UNIX_SOCKET_PROXY` (bool, default false).
- `getProxyWarning`: on a unix socket in production-like mode, warns when the flag is missing; with the flag, the warning is silent.
- Docs: `documentation/backend/security.md`, `configuration.md`, `deployment.md`, `packages/backend/.env.example`.

## Files Modified

- `packages/backend/src/vendor/utils/network/ip-address.ts` (new) + spec, `get-ip.ts` + spec
- `packages/backend/src/vendor/utils/rate-limit/rate-limit-store.ts`
- `packages/backend/src/app/services/auth/auth-throttle-service.ts` + `.redis.test.ts`
- `packages/backend/src/config/network.ts`, `src/app/start/validate-runtime-config.ts` + spec
- Docs as above.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 2284, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` with Redis: 24 files / 218 passed. `test:redis`: 9 files / 93 passed.
- Unit:
    - five spellings of one /64 give one key, and another /64 gives another;
    - IPv4-mapped addresses map to IPv4, and junk maps to `unknown`;
    - unix-socket mode:
        - a spoofed left entry is ignored;
        - trusted CIDRs in the chain are skipped;
        - X-Real-IP is the fallback;
        - without the flag, or on TCP with an empty address, the client is `unknown`;
        - the full IPv6 address is kept;
    - the proxy warnings.
- Redis: three addresses of one /64 share a `keyBy: 'ip'` budget, another /64 does not, and `keyBy: 'user'` keys stay as they are.
- Mutation check: with `main`'s `get-ip.ts`, `rate-limit-store.ts`, `auth-throttle-service.ts`, `validate-runtime-config.ts` and `network.ts`, the new unix-socket, warning and Redis /64 cases fail. The "no flag" and "TCP empty address" cases are guards that pass there too.
- Manual: the built backend on a unix socket (`APP_UNIX_PATH=/tmp/vt-r07.sock`, `TRUST_UNIX_SOCKET_PROXY=true`), `curl --unix-socket` to `POST /api/auth/forgot-password` (route limit 3/min):
    - XFF `198.51.100.1, 203.0.113.7` ×4 → 200 200 200 429;
    - XFF `203.0.113.8` → 200;
    - 4 different addresses of `2001:db8:1:2::/64` → 200 200 200 429;
    - `2001:db8:1:3::a` → 200.
- Found while testing: a socket path longer than macOS' 104-character limit made `listen_unix` fail and the process exit with code 1 and no log line. That is R08's finding 14 (`listen_unix` does not check the token), still open in the plan.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next by the plan order: R09 (session store hardening; Д2 and Д6 are taken).
