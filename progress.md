# feat-104 — Push Endpoint SSRF

Plan: `docs/plan/code-review-2026-11-03-plan.md`, item R03 (owner decision Д1: allowlist of hosts). Branch: `fix/feat-104-push-endpoint-ssrf` (from `main` at `486f25b`, `main` merged in after #348).

## Current State

Implemented; PR open.

- `config/push.ts`: `readPushConfig(env)` (testable).
    - `PUSH_ALLOWED_ENDPOINT_HOSTS`: comma list; default FCM, Mozilla, `.notify.windows.com`, Apple. Entries are validated as host names or `.domain` suffixes.
    - `PUSH_MAX_SUBSCRIPTIONS_PER_USER`: default 20, min 1.
    - `configError` is wired into `validateRuntimeConfig` (`Invalid push configuration`).
- `services/notifications/push-endpoint-policy.ts` (new) `isAllowedPushEndpoint` requires:
    - `https:`, no userinfo, no explicit port, no IP literal;
    - a host that equals an entry, or is a subdomain on a DNS label boundary for a `.domain` entry. The host is lowercased, the trailing dot dropped, and IDN compared in punycode.
- `push-subscription-service.ts` `upsertSubscription`:
    - endpoint not allowed → `400 push_endpoint_not_allowed`, before any DB access;
    - a new or moved-in subscription at the cap → `409 push_subscription_limit`, counted with `countByUserId(userId, tx)` under the user row lock of `withCurrentSession`.
- `push-notification-sender-service.ts`: re-checks every endpoint before sending, skips disallowed ones with a `warn`, and passes no proxy/agent options to `web-push`.
- `http-routes.ts`: `POST /push-subscriptions/test-push` limited to 5/min.
- `push-notification-log-transformer.ts` + `shared` `PushLogRowSchema`:
    - responses carry `statusCode` and `reason` (`gone` / `rejected` / `network_error` / `null`) instead of `errorMessage` / `responseData`;
    - this covers `GET /push-subscriptions/:id/logs` and `GET /:id` `notificationLogs`. `GET /push-subscriptions` summaries never had them.
- Docs: `documentation/backend/web-push-notification.md` (new section «Обмеження endpoint», log shape, config), `configuration.md`, `packages/backend/.env.example`.

## Files Modified

- `packages/backend/src/config/push.ts`, `push.spec.ts` (new)
- `packages/backend/src/app/start/validate-runtime-config.ts`
- `packages/backend/src/app/services/notifications/push-endpoint-policy.ts` (new) + spec; `push-transport-redirect.spec.ts` (new)
- `packages/backend/src/app/services/notifications/push-subscription-service.ts` + spec; `push-notification-sender-service.ts` + spec
- `packages/backend/src/app/repositories/notifications/push-subscription-repository.ts` (`countByUserId`)
- `packages/backend/src/app/transformers/push-notification-log-transformer.ts` + spec
- `packages/backend/src/app/routes/http-routes.ts`
- `packages/shared/src/responses/push-subscription-controller.ts`
- `packages/backend/src/app/controllers/http/notifications/push-subscription-ownership.pg.test.ts` (fixtures on an allowed host, new feat-104 block)
- Docs and `.env.example` as above.

## Evidence of Completion

See the PR description. In short: typecheck, lint, format clean; `pnpm test`; `test:pg` (`push-subscription-ownership.pg.test.ts` 22 passed over real HTTP + PostgreSQL); docs build + verify. The mutation check is that all 7 new HTTP cases fail with `main`'s service, transformer, routes and shared schema.

Manual / transport: `push-transport-redirect.spec.ts` sends with real `web-push` to a local TLS server that answers 302 to a second server. The send fails with `statusCode: 302`, and the second server gets 0 requests.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next by the plan order: R11a (prompt `$&` replace), then R06a (phone reset transaction, needs feat-103's executors).
