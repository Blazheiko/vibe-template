# feat-132 — Strict Trusted Proxy CIDRs (P2)

## State

Done on branch `fix/feat-132-strict-proxy-cidrs`; start PR #429. Waiting for CI on the feature PR.

## Changes

- `vendor/utils/network/ip-address.ts`: `parseCidr` reads the prefix only as `^\d{1,3}$` within the
  address length (96–128 for an IPv4-mapped network); `isIpInCidr` matches nothing for anything
  else. `Number('')`, `Number(' 0')` and `Number('.0')` are 0, so `10.0.0.0/`, `10.0.0.0/ 0` and
  `10.0.0.0/.0` were /0 and trusted every address. New `isValidCidrEntry`.
- `config/network.ts`: `readNetworkConfig(env)`; an entry of `TRUSTED_PROXY_CIDRS` that is neither
  an address nor a CIDR is a network `configError`, and `validateRuntimeConfig` stops the start.
- Docs: `configuration.md`, `security.md`.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean
- `pnpm test`: backend 2506, frontend 400, api-playground 62; `pnpm docs:build && pnpm docs:verify`
- Reproduced with tsx before the fix: `isIpInCidr('203.0.113.7', '10.0.0.0/')` → true (also `/ 0`,
  `/.0`); after: false.
- Mutation: main `ip-address.ts` + `network.ts` → 30 cases fail (strict prefixes, valid entries,
  config errors, startup rejection).
- No value in the repository (`.env.example`, CI, e2e) becomes an error: the example leaves the
  variable empty.
