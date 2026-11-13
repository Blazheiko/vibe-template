# feat-201: In-Flight Body Budget

Plan: `docs/plan/security-review-2026-11-12-plan.md`, S07. Finding: M-3 (part 1) of
`docs/security/security-review-2026-11-12.md`. Branch: `fix/in-flight-body-budget`.

## Current State

Done, in review.

- A request body is read into memory before the session, CSRF and auth middlewares, and the
  rate limits count requests, not bytes. `body-budget.ts` counts the bytes of bodies being
  buffered, in total and per client address. `readData` charges every chunk as it arrives and
  gives the bytes back once, however the read ends (complete, aborted, too large, refused,
  failed).
- Over the per-address limit: 429 `rate_limited`; over the total: 503 `service_unavailable`.
  Both with `Retry-After: 1`, and the connection is closed with the answer (uWS
  `res.end(body, true)`), so the rest of the body is not read. Logged at `warn`.
- Limits: `APP_MAX_INFLIGHT_BODY_BYTES` (256 MiB) and `APP_MAX_INFLIGHT_BODY_BYTES_PER_IP`
  (64 MiB); `0` switches a limit off.
- The per-address default is 64 MiB, not the 16 MiB the plan proposed: it must cover the
  largest body a route takes, and multipart allows 50 MiB by default.
- No body read timeout was added: measured on uWS 20.71, a stalled upload is closed by the
  server after about 12 s, and so is one that sends a byte every 5 s. The budget bounds what
  can be held inside that window.

## Files Modified

- `packages/backend/src/vendor/utils/network/body-budget.ts` (new),
  `errors/body-budget-exceeded-error.ts` (new), `errors/http-error.ts`,
  `errors/classify-error.ts`, `http-request-handlers.ts`
- `packages/backend/src/vendor/start/server.ts`, `config/app.ts`, `.env.example`
- tests: `body-budget.spec.ts` (new), `in-flight-body-budget.transport.spec.ts` (new),
  `config/app.spec.ts`, `malformed-body.spec.ts`, `upload-limits.transport.spec.ts`
- docs uk+en: `backend/configuration.md`, `backend/request-lifecycle.md`;
  `docs/plan/http-body-limits-plan.md`

## Evidence of Completion

- `make check`: passing (backend 2887, frontend 558, playground 115).
- `pnpm docs:build && pnpm docs:verify`: passing.
- `pnpm --filter backend test:pg` (32 files, 312 passed) and `test:redis` (11 files, 117
  passed) on real services.
- On a real uWS server (`in-flight-body-budget.transport.spec.ts`, raw sockets, passed 3 of 3
  runs): a stalled upload holds its bytes; the next body of the address over the budget gets
  429 with `Connection: close` and the server closes the socket; a body that still fits is
  handled; the bytes come back when the stalled client goes away; six stalled uploads never
  hold more than the budget.
- RED: without the charge in `readData`, 10 of the new cases fail.
- `upload-limits.transport.spec.ts`: 20 parallel 50 MiB uploads from one address are now
  refused with 413 or 429 (the address is over its 64 MiB budget before every upload reaches
  the route limit); the test accepts both and checks the budget returns to zero.
- Measurement (a temporary test, not committed): a stalled upload was closed by uWS after
  11 969 ms; an upload sending one byte every 5 s after 11 993 ms; the budget was back to 0.
- Whole `e2e-live` suite: 14 passed.

## Notes for Next Session

Next: feat-202 (pre-auth body limits: smaller JSON default, rate limit on the knowledge base
group, cookie check before a multipart body is read).
