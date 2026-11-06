# feat-139 — Seventh Review Lows (J1)

## State

Done on branch `fix/feat-139-seventh-review-lows`. Waiting for CI on the feature PR.

## Changes

- **Q1** `scrub-error.ts` (`walk`): a value with `toJSON` is no longer opaque. What `toJSON`
  returns is walked (pino writes that), so an error it returns or holds is replaced by its safe
  copy; a `toJSON` returning its own object is walked as its fields; a throwing one becomes
  `[toJSON failed]` instead of breaking the line. Nothing to replace: the value is kept as is.
- **Q2** `sentry-service.ts` (`sanitizeDeep`): past `MAX_SANITIZE_DEPTH` an object becomes
  `[Truncated]` instead of being sent raw; a `toJSON` returning `this` is read as fields.
- **Q3** `sentry-service.ts`: a `URL` is sent as its string with every query value, the fragment
  and userinfo replaced by `[Filtered]` (keys kept).
- **Q4** new `push-transport.ts`: `sendPush` builds the request with web-push's
  `generateRequestDetails` and sends it with `https.request` under `AbortSignal.timeout` over the
  whole exchange (web-push's `timeout` is only the socket idle timeout). No redirects, non-2xx →
  `WebPushError` with the status, no proxy or agent in the app. The sender uses it.
- **Q5** docs: `oauth.md` (`resend` → `429 rate_limited`), `observability.md`,
  `web-push-notification.md`.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean
- `pnpm test`: backend 2544, frontend 400, api-playground 62; `pnpm docs:build && pnpm docs:verify`
- Transport on a real local TLS server: 302 not followed, 201 resolves, a server writing a byte
  every 50 ms is cut at the 300 ms deadline.
- Mutation: main `scrub-error.ts` + `sentry-service.ts` → 4 new cases fail; main sender (web-push
  `sendNotification`) → 8 sender cases fail.
- No PG/Redis code touched.
