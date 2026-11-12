# feat-194: Sentry Spans and Extra Without URL Tokens

## Current State

Implemented, waiting for review. Both findings of the security review of `main` at 68789d6 are
fixed and pinned by tests on the real `@sentry/vue` 11.10.0 SDK.

## Changes

1. **HIGH — tokens in navigation spans.** `instrumentVueRouter` copies every query parameter
   into a `query.<name>` span attribute and the URL into `url.full` / `url.query`. Spans do not
   pass through `beforeSend`, and Sentry 11 streams them by default (`traceLifecycle: 'stream'`),
   so `beforeSendTransaction` is not called either. `sentry-service.ts` now passes
   `beforeSendSpan`: `query.<sensitive>` and attribute keys matching `SENSITIVE_KEY_RE` become
   `[Filtered]`, `url.query`/`http.query` are masked as query strings, any other string attribute
   (and the span name) goes through `maskUrlsInText`.
2. **MEDIUM — full URL in `extra`.** `main.ts` `router.onError` sends `to.path` and the route
   name instead of `to.fullPath`; `beforeSend` now cleans `extra` with `sanitizeTree(…, 'filter')`,
   and `sanitizeTree` masks URLs inside any string, not only under URL-like keys.
3. `maskUrl` filters every query parameter matching `SENSITIVE_KEY_RE` too (`reset_token`), and
   returns the input unchanged when nothing was filtered (a plain `/account` stays relative).
4. Docs uk+en: `backend/observability.md`, section "Sentry (frontend)".

## Evidence of Completion

- `make check`: passing — backend 2702, frontend 548, playground 115, shared 39, docs 26.
- `pnpm docs:build && pnpm docs:verify`: passing.
- `sentry-tracing.spec.ts` (real SDK, `fetch` stubbed as the transport, canary token):
  navigation to `/reset-password?token=…` with traces rate 1, and a failed navigation whose
  handler still passes `to.fullPath`. Without the fix both fail with the token in the sent
  envelope (`query.token` in the span, `extra.targetRoute`); with it both pass.
- e2e: run by CI on the PR.

## Notes for Next Session

- After merge: "Mark feat-194 done" PR on `main` (status, evidence), deleting this file.
