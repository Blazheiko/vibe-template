# feat-215: Header Value Check On The Live Server

Plan: `docs/plan/security-review-2026-11-12-follow-ups-plan.md`, F03 (follow-ups item 6, L-14).

## Current State

Done, ready for review. No production code changed: the cause is uWebSockets.js.

## What Was Found

A real uWebSockets.js 20.71.0 server got raw request bytes from a socket (no curl). uWS trims
bytes above 0x7F at both ends of a header value, as it trims spaces: `café` arrives as `caf`,
`écafe` as `cafe`, `éé` as an empty string, a Latin-1 `caf\xe9` as `caf`. That is why
`x-utf: café` passed the check on the live stack. A byte above 0x7E inside the value
(`caféXYZ tail`) does reach `getHeaders`, and `HEADER_VALUE_PATTERN` refuses it with the one
`debug` line of feat-206. So no byte above 0x7E reaches the application either way; the report
was imprecise only about the edges.

## What Changed

- `packages/backend/src/vendor/utils/network/header-values.live.spec.ts` (new): both behaviours
  on a live server, so a uWS upgrade that changes the edge trimming is noticed.
- `docs/security/security-review-2026-11-12.md`: note 2 (L-14) gives the cause.
- `docs/security/security-review-2026-11-12-follow-ups.md`: item 6 explained and closed.
- `docs/plan/security-review-2026-11-12-follow-ups-plan.md`: marked done.

## Evidence of Completion

- The first version of the test expected `x-utf: café` to be refused and failed
  (`expected true to be false` on `has('x-utf')`); a probe printed the value uWS hands over
  (`"caf"`, 3 chars), then the edge cases above.
- `make check`: passed (backend 2983 with the 2 new tests, frontend 607, api-playground 115).

## Next Step

Merge, mark `feat-215` done. The plan is then complete.
