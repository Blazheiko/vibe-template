# Mail

The backend sends emails over SMTP using [nodemailer](https://nodemailer.com/). The channel is disabled until the `SMTP_*` variables are set: the list and default values are described in [Configuration](/en/backend/configuration). Push notifications are described separately: [Web Push notifications](/en/backend/web-push-notification).

## Transport

The [`email-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/notifications/email-service.ts) service creates a single lazy `nodemailer` transport (`createTransport`) with `host`, `port`, `secure`, optional `requireTLS`/`ignoreTLS` and `auth` (only if both `SMTP_USER` and `SMTP_PASSWORD` are set). The settings come from [`config/mail.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/mail.ts).

The public API is the `emailService` object:

- `isConfigured(): boolean` — whether the configuration check passed;
- `send(input: SendEmailInput): Promise<AppResult<SendEmailOutput>>` — returns a `Result` (`better-result`), does not throw exceptions.

`SendEmailInput` supports `to`, `cc`, `bcc`, `replyTo` (a string, `{ email, name? }` or an array), `subject`, `text`/`html`, `from` and `attachments`. If `from` is not set, `SMTP_FROM_NAME <SMTP_FROM_EMAIL>` is used; if `replyTo` is not set, `SMTP_REPLY_TO` from the config is used.

## Behavior when SMTP is disabled

Mail is **not replaced with logging**. Before every send, `send()` checks the configuration and, on failure, writes a `logger.warn` and returns `Result.err(internalMessage(...))`. Possible reasons:

- `Email service is disabled` — `SMTP_ENABLED` is not `true`;
- `SMTP_HOST is not configured`;
- `SMTP_FROM_EMAIL is not configured`;
- `SMTP_USER and SMTP_PASSWORD must be configured together`.

Next, the input is validated (empty `subject`, neither `text` nor `html`, an empty recipient list, an empty sender) — this is a `badRequest`. An SMTP failure is thrown as an exception ([ADR 0004](https://github.com/Blazheiko/vibe-template/blob/main/docs/adr/0004-result-for-expected-outcomes.md)): an HTTP request waiting for the email gets a 500 with a single log entry, while a background send catches the exception and logs it itself (`Unexpected error while sending … in background`). There is no longer a separate `Failed to send email` entry (with the recipient address). Success is logged as `Email sent` with `messageId`, `accepted`, `rejected`; the addresses in that entry are masked (`maskEmailForLogs`), while the caller gets them as they are.

::: warning Consequence for auth flows
Because a `send()` failure is thrown, with SMTP disabled the requests that wait for an email (for example, linking an email) end with a server error rather than "quietly" succeeding. Background sends (the email after registration, "forgot password") respond as usual and only log the failure. This path does not work for local development without SMTP — see [Local testing](#local-testing).
:::

## Which emails are sent

There are no template files and no i18n: the subject, `text` and `html` are built in code, in English. The markup lives in one place — `renderBrandedEmail` in [`email-templates.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/notifications/email-templates.ts) (the `EMAIL_BRAND` palette; `escapeHtml` escapes every field: the name, the link, as well as `preheader`, `eyebrow`, `title`, `intro`, the button text and `footer`, because a caller may insert external data into them, as the OAuth link email inserts the name from the provider profile into `intro`, feat-108); each of the functions below only passes the wording and the action type (a button with a fallback link, or a single link). The email is pinned byte for byte by the files in [`__snapshots__`](https://github.com/Blazheiko/vibe-template/tree/main/packages/backend/src/app/services/auth/__snapshots__).

| Email                                                                    | Template function                                 | Where it is called                                                                                                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email confirmation ("Confirm your email")                                | `buildEmailContent`                               | [`email-verification-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/email-verification-service.ts)                        |
| Linking a new email to the account                                       | `buildLinkEmailContent`                           | [`email-verification-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/email-verification-service.ts)                        |
| Password reset                                                           | `buildResetEmailContent`                          | [`password-reset-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/password-reset-service.ts)                                |
| Linking an OAuth provider to the account ("Link GitHub to your account") | `renderBrandedEmail` directly (`startMailedLink`) | [`oauth-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/oauth-service.ts), see [OAuth](/en/backend/oauth#linking-by-email) |

The links in the emails contain the raw token, while only its hash is stored in the DB. Flow details are in [Authentication](/en/backend/auth#sign-in-methods).

## Test email: `mail:test`

The [`send-test-email.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/scripts/send-test-email.ts) script (`tsx`, loads `.env` via `dotenv/config`) sends a simple email through the same `emailService`:

```bash
pnpm --filter backend mail:test you@example.com "Optional subject"
```

Without a recipient, the script prints usage and exits with code `1`. On error it prints `Failed to send test email: <reason>` (for example `Email service is disabled`) and also returns `1`; on success it prints the `Message ID` and the accepted recipients. See also [Scripts](/en/reference/scripts).

Unit tests for the service — [`email-service.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/notifications/email-service.spec.ts).

## Local testing

[`docker-compose.yml`](https://github.com/Blazheiko/vibe-template/blob/main/docker-compose.yml) has a `mailpit` service that catches every outgoing email: SMTP on `127.0.0.1:1025`, the web UI at `http://localhost:8025`. Start it (`make services-up` or `pnpm services:up`; only it — `make services-up ARGS=mailpit`), set `SMTP_ENABLED=true`, `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025`, `SMTP_REQUIRE_TLS=false`, `SMTP_IGNORE_TLS=true`, `SMTP_FROM_EMAIL=noreply@example.com` without a login/password, and check with `pnpm --filter backend mail:test you@example.com`. The application container of the `app` profile is already configured for `mailpit`.

Unit tests: `pnpm --filter backend test`.
