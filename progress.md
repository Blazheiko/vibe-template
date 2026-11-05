# feat-122 — Lease and Proxy Chain (G2 = L6–L8)

Plan: `docs/plan/code-review-2026-11-03-plan.md`, «Четверте рев'ю 2026-11-04», G2; start #399. Branch: `fix/feat-122-lease-and-proxy-chain`.

## Current State

Implemented; PR open.

- **L6** (`services/shared/redis-lease.ts`):
    - the lease runs on `performance.now()`;
    - "lost" is a timer of its own at `extendedAt + ttlMs - renewEveryMs`, re-armed after every successful renewal, with `extendedAt` taken at the start of that renewal call;
    - the maximum lifetime is a timeout as well;
    - the renewal tick only renews;
    - a renewal that answers after the lease was lost changes nothing;
    - release stops all timers.
- **L7** (`vendor/utils/network/get-ip.ts`):
    - `parseForwardedEntry` reads `a.b.c.d:port` and `[v6]:port`;
    - the chain keeps unreadable entries as `null`;
    - the right-to-left walk stops at one, and the caller falls back to `X-Real-IP`, then the remote address.
- **L8:** the unix-socket chain skips `TRUSTED_PROXY_CIDRS` regardless of `TRUST_PROXY` (`inTrustedCidrs`), and `TRUST_UNIX_SOCKET_PROXY` stays the switch.
- Docs: `security.md`, `configuration.md` (`TRUST_UNIX_SOCKET_PROXY`), `ai.md` (lease deadline).

## Files Modified

- `packages/backend/src/app/services/shared/redis-lease.ts`, `src/app/services/support/support-inflight-lock.spec.ts`
- `packages/backend/src/vendor/utils/network/get-ip.ts` + spec
- Docs as above.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `git diff --check` clean.
- `pnpm test`: backend 2373, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` with Redis: 28 files / 248 passed. `test:redis`: 11 files / 114 passed, including the support lock and KB init lease suites.
- **L6 spec** (fake timers including `performance`):
    - TTL 3.5 s, renewals every 1 s, Redis silent → not lost at 2.4 s, lost at 2.55 s (`main` sees it only at the 3 s tick);
    - a renewal sent at 1 s and answered at 1.9 s → lost at 4 s, not 4.9 s;
    - after release, nothing renews.
- **L7 spec:**
    - `203.0.113.7:51234` and `[2001:db8::7]:443` are the client;
    - `1.2.3.4, garbage` → the remote address, or `X-Real-IP` when given, and not the forged `1.2.3.4`;
    - garbage left of the client does not matter.
- **L8 spec:** with `TRUST_PROXY=false`, a CDN hop in `TRUSTED_PROXY_CIDRS` is skipped on the unix socket.
- Mutation check: `main`'s lease fails the deadline case, and `main`'s get-ip fails 4 new cases.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next by the plan: G3 (session and auth: L5, the F6-low safeEqual order, R06b 429).
