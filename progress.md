# feat-150 — Log Privacy: Support, Push, Mail (V04)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V04), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (V04.S–V04.X). Finding M3 of
`docs/plan/code-review-2026-11-10-report.md` and three low findings of the same kind.

## Goal

Four log entries carried what the user wrote or provided, or a value that works as a secret.

## State

Done, waiting for review and merge.

## What changed

| Where                                                        | Before                                                                                                                           | Now                                                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `services/support/support-query-translation-service.ts`      | a failed translation logged the whole support message (`originalQuery`) at error level, also when the client just closed the tab | only `originalLength`; an abort by the client is an `info` entry, not an error                |
| `services/notifications/push-notification-sender-service.ts` | a failed send logged the `WebPushError` object: the subscription's endpoint, the headers and body of the push service's answer   | `subscriptionId`, `statusCode`, `errorName`; the error text stays in the notification log row |
| `services/notifications/email-service.ts`                    | `Email sent` logged full recipient addresses                                                                                     | masked with `maskEmailForLogs`; the caller still gets them as they are                        |
| `controllers/http/auth/oauth-controller.ts`                  | the redirect logged the authorization URL with the single-use `state` and the PKCE challenge                                     | the provider's name only                                                                      |

Docs (both locales): `observability.md` (the rule and the four cases), `mail.md`, `ai.md`,
`oauth.md`, `web-push-notification.md`.

## Evidence of Completion

### V04.T — RED (before the fix)

Four findings, each reproduced on its own (5 tests):

```
 × logs the failure without the text of the message
   AssertionError: expected '[[{"err":{},"originalLength":51,"orig…' not to contain 'Мій пароль не приймається, пошта olen…'
 × does not log an error when the client went away during the translation
   AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times
 × logs the status code, not the endpoint, headers or body of the push service answer
   AssertionError: expected '[[{"err":{"name":"WebPushError","stat…' not to contain 'fcm/send/1'
 × masks the recipients it logs
   AssertionError: expected '[[{"messageId":"message-1","accepted"…' not to contain 'olena.kovalenko@example.com'
 × redirects to the provider without logging the URL or the state
   AssertionError: expected '[[{"url":"https://accounts.example/au…' not to contain 'state-secret-1'
 Tests  5 failed | 49 passed (54)
```

### After the fix

- The four specs: 54 passed.
- `pnpm format:check`, `pnpm typecheck`, `pnpm lint`: clean.
- `pnpm test`: backend 193 files / 2597 tests, frontend 413, api-playground 62 — all passed on
  the second run (see below).
- `pnpm docs:build && pnpm docs:verify`: passed.

### Flaky test seen during this feature (not caused by it)

The first full `pnpm test` run failed in
`src/vendor/start/upload-limits.transport.spec.ts` › "does not buffer 20 parallel 50 MiB uploads":
one of the uploads answered `400 Bad Request` instead of `413 Payload Too Large`. The spec passed
5 times in a row on this branch and 3 times on unchanged code when run alone, and the next full
run was green. It had passed in the five earlier full runs of the day. This feature does not touch
uploads. Recorded in the review report for triage.

### Manual verification

Not done against a running server: each of the four log entries is asserted on the logger call
itself, which is where the value used to leak.

## Notes for Next Session

- A push failure no longer reaches Sentry as an exception with the full error: the entry has no
  `err` object. The error text is in `push_notifications_log.error_message`.
