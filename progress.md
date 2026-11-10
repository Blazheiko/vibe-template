# feat-148 — Push Subscription Account Sync (V02)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V02, decision Д1: remove), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (V02.S–V02.X). Finding M9 of
`docs/plan/code-review-2026-11-10-report.md`.

## Goal

The browser keeps its push subscription across sign-outs and accounts, and the server sends to
whoever owns the record. The frontend reported push as enabled without telling the server, and a
sign-out left the subscription in place, so in a shared browser B saw "enabled" while A kept
receiving. The store now keeps the browser and the server in step.

## State

Done, waiting for review and merge.

## What changed

- `packages/frontend/src/stores/push.ts`
    - `subscribeToPush` always posts the subscription (also one the browser already has) and
      reports "enabled" only after the server's answer; a refusal leaves it disabled and a retry
      posts the same subscription again.
    - `ensurePushSubscriptionsLoaded`: "enabled" is about this browser — its subscription must
      be an active record of the signed-in account. A browser subscription that is not among the
      account's records was left by another account and is removed (Д1).
    - `releaseBrowserSubscription` (new): at sign-out removes the server record and the browser
      subscription; best effort, bounded by 3 s.
    - Endpoints are compared in the spelling the server stores (lower-case host, upper-case
      percent escapes).
- `packages/frontend/src/composables/useSessionLifecycle.ts` — `logout` releases the
  subscription before the logout request, in a `try` of its own.
- `packages/frontend/src/App.vue` — `initializeApp` runs the reconciliation after a sign-in.
- Tests: `stores/__tests__/push.spec.ts` (20), `composables/__tests__/useSessionLifecycle.spec.ts`
  (3, new), `e2e-live/push-account-switch.spec.ts` (3, new),
  `packages/backend/src/app/services/notifications/push-delivery-ownership.pg.test.ts` (3, new).
- `packages/frontend/playwright.live.config.ts` — a VAPID key pair per run.
- Docs: `documentation/backend/web-push-notification.md` (+ `en/`), composables README.

## Behaviour change to review

The toggle on the account page used to be on when the account had an active subscription on
**any** device. It is now on only when **this browser's** subscription is an active record of the
account. Without that, B's settings in a shared browser could not show push as off. The old test
"knows the account is subscribed (somewhere)" was replaced accordingly.

## Evidence of Completion

### V02.T — RED (before the fix)

`pnpm exec vitest run src/stores/__tests__/push.spec.ts`

```
 × sends the subscription the browser already has to the server before reporting it enabled
   AssertionError: expected "vi.fn()" to be called with arguments: [ ObjectContaining{…} ]
 × is not enabled when the server refuses the subscription, and a retry posts it again
   AssertionError: expected true to be false // Object.is equality
 Tests  2 failed | 10 passed (12)
```

### After the fix

- `pnpm format:check`, `pnpm typecheck`, `pnpm lint`: clean.
- `pnpm test`: backend 192 files / 2562 tests, frontend 35 files / 412 tests, api-playground 62,
  all passed.
- Backend PG, `push-delivery-ownership.pg.test.ts`: 3 passed (transport replaced; after a move the
  previous owner's send makes no request, after a delete nobody's does). This one was green from
  the start: it pins existing backend behaviour.
- `pnpm --filter frontend test:e2e`: 87 passed.
- `pnpm --filter frontend test:e2e:live` (real backend, PostgreSQL 16 + pgvector, Redis; only
  `PushManager` replaced): 8 passed, including the three new scenarios:
    1. A enables push → signs out → the browser has no subscription and the server has no record of
       A → B signs in, the toggle is off, B has no subscriptions → B enables → B's own new endpoint,
       an empty log.
    2. A's session ends without a sign-out → B signs in → the leftover subscription is removed, the
       toggle is off, B has no record → B enables its own.
    3. The first save is aborted on the way → the toggle stays off with an error → the retry saves
       the subscription the browser already has.
- `pnpm docs:build && pnpm docs:verify`: `verify-dist: all checks passed`.

### Not verified / open

- Real delivery through a push service (FCM) in a real browser was not exercised: the e2e
  replaces `PushManager`, and the backend test replaces the transport.
- The first of 7 local runs of the new live spec failed once in scenario 3 at sign-in:
  `POST /api/auth/login` answered 503. It did not repeat in the next 6 runs of the spec or in 2
  runs of the whole live suite; the server log of that run was not captured, so the cause is
  unknown. If it shows up in CI, capture the webServer output (`stdout: 'pipe'`).
- A lost session (`redirectToLogin`) does not release the subscription: without a session the
  server record cannot be removed. The leftover is removed when the next account signs in.

## Notes for Next Session

- feat-168 (C1, route contracts pilot) depends on this feature and rewrites the same API calls.
- The local PG suites and the live e2e ran against the container `vibe-test-pg`
  (`pgvector/pgvector:pg16`, port 55433; `PGSQL_HOST/PORT/USER/PASSWORD` overridden for the live
  run): the local PostgreSQL 15 has no pgvector.
