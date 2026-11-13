# feat-213: Dependabot Digest Only And Hono Overrides

Plan: `docs/plan/security-review-2026-11-12-follow-ups-plan.md`, F01 (follow-ups items 1, 2, 4).

## Current State

Done, ready for review.

## What Changed

- `.github/dependabot.yml`: the `docker` entry ignores semver-major and semver-minor updates of
  `ubuntu`, so Dependabot moves only the `ubuntu:24.04` digest (decision D7). PR #633 (24.04 →
  25.10) was closed on 2026-11-13.
- Root `package.json`, `pnpm.overrides`: `hono@<4.13.16` → `^4.13.16`,
  `@hono/node-server@>=2.0.0 <2.1.6` → `^2.1.6`. Both come only through
  `@mistralai/mistralai@3.4.0` → `@modelcontextprotocol/sdk@1.32.2`; Mistral 3.5.0 pulls the same
  range, so it stays pinned. The lockfile moves `hono` 4.13.14 → 4.13.18 and
  `@hono/node-server` 2.1.5 → 2.1.8, nothing else.
- `docs/security/security-review-2026-11-12-follow-ups.md`: items 1–4 marked fixed / done.

## Files Modified

- `.github/dependabot.yml`, `package.json`, `pnpm-lock.yaml`
- `docs/security/security-review-2026-11-12-follow-ups.md`

## Evidence of Completion

- `pnpm audit --prod`: before, 7 vulnerabilities (1 low, 6 moderate) in `hono` /
  `@hono/node-server`; after, `No known vulnerabilities found`.
- `make check`: passed (backend 2981, frontend 607, api-playground 115).
- Manual: the Mistral SDK loads with the new transitive versions and builds a client
  (`new Mistral({ apiKey })`, `chat.complete` is a function); no network call.
- Repository settings (item 4): Dependabot alerts and security updates enabled on 2026-11-13
  (`automated-security-fixes: enabled`); `audit.yml` run 43462205330 green (item 3).

## Not Yet Verified

- That Dependabot opens digest-only PRs and no tag PRs under the ignore rule: visible only on
  its next weekly run after merge.

## Next Step

Merge, mark `feat-213` done; next feature: feat-215.
