# What is implemented: account and admin area

A single page on which account-management scenarios and admin features the template already has, and which it does not. It is compiled from the feature registry (`feature_list.json` on `main`) and the code; every row links to the page that describes it in detail. For an overview of everything the template offers, see the [home page](/en/#what-is-already-implemented).

The list of scenarios comes from an internal analysis, [`template-functionality-recommendations.md`](https://github.com/Blazheiko/vibe-template/blob/main/docs/plan/future/template-functionality-recommendations.md). It holds proposals, not an agreed plan: what is missing here is not promised.

## Account scenarios

| Scenario                         | Status          | Feature                      | What exists                                                                                                                          | Details                                                    |
| -------------------------------- | --------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Profile editing                  | Implemented     | feat-232                     | Name, interface language, time zone; theme, colour and font size are stored on the server and synced between devices                 | [Account](/en/backend/account)                             |
| Active sessions                  | Implemented     | feat-233                     | List of sessions (browser, OS, IP, sign-in method, last seen), the current one marked, end one or all others                         | [Account](/en/backend/account#active-sessions)             |
| Audit log                        | Implemented     | feat-235                     | Append-only `audit_events` table: actor, action, target, before/after, request ID; filters; an admin page; retention                 | [Audit log](/en/backend/audit-log)                         |
| Notification center              | Implemented     | feat-236                     | In-app history, unread counter, opening the object, email/push settings per category, retention                                      | [Notification center](/en/backend/notifications)           |
| Roles and permissions            | Implemented     | feat-240, feat-241           | Five roles, a closed permission catalog, `can:<permission>` on routes, role assignment with a delegation policy                      | [Roles and capabilities](/en/reference/roles-capabilities) |
| MFA and passkeys                 | Implemented     | feat-245…248, fixes 249…259  | TOTP, passkeys, recovery codes, step-up for sensitive actions, a mandatory second factor for staff                                   | [MFA](/en/backend/mfa)                                     |
| Data export and account deletion | Not implemented | —                            | No routes and no page. Self-service stays a proposal                                                                                 | —                                                          |
| Durable deferred operations      | Not implemented | —                            | Emails and push are sent without a database queue. Scheduled jobs exist (see below), but not a queue with retries and statuses       | [Background jobs](/en/backend/scheduler)                   |
| Data retention                   | Partial         | feat-065, 223, 224, 235, 236 | Covers one-time tokens and SMS challenges, AI prompt text, the audit log and notifications. Not presence history, push logs or chats | [Background jobs](/en/backend/scheduler#jobs)              |
| Metrics and operations panel     | Not implemented | —                            | There are structured logs, Sentry and the `/ping`, `/ready` health checks; no response-time or error metrics and no panel            | [Observability](/en/backend/observability)                 |

::: info Optional modules
Organizations and teams, plans and quotas, API keys and webhooks, and handing an AI chat to a human are not part of the template and stay optional depending on the product.
:::

## Admin area

The admin area at `/admin` opens to roles with at least one permission (`isStaffRole`). The menu shows only the pages a role has the permission for; the backend checks every request just the same.

| Page           | Path                    | Permission needed      | What it does                                                                                        | Details                                                    |
| -------------- | ----------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Knowledge Base | `/admin/knowledge-base` | `kb.read`              | Articles, screenshots, reindexing one article; writing needs `kb.write`, reindexing all `kb.manage` | [AI](/en/backend/ai)                                       |
| Users          | `/admin/users`          | `users.read`           | User list; user card; changing a role needs `users.roles.assign`, resetting MFA `users.mfa.reset`   | [Roles and capabilities](/en/reference/roles-capabilities) |
| User Online    | `/admin/user-online`    | `users.read`           | Current users in real time over WebSocket                                                           | [WebSocket](/en/backend/websocket)                         |
| History Online | `/admin/history-online` | `users.sensitive.read` | Presence history with IP and user agent                                                             | [WebSocket](/en/backend/websocket)                         |
| Audit Log      | `/admin/audit-log`      | `audit.read.account`   | Log events with filters; without `audit.read`, sign-ins and sessions only                           | [Audit log](/en/backend/audit-log#the-admin-page)          |

API only, without a page in the interface:

- **AI prompts** (`prompts.manage`): the `api/prompts` routes; there is no admin page.
- **AI usage statistics** (`ai_usage.read`): `GET /admin/usage/text` and `/admin/usage/stats`.

### Roles

| Role               | Permissions                                                            |
| ------------------ | ---------------------------------------------------------------------- |
| `user`             | no admin access                                                        |
| `support_operator` | `users.read`, `audit.read.account`, `kb.read`                          |
| `kb_editor`        | `kb.read`, `kb.write`                                                  |
| `user_admin`       | `users.read`, `users.roles.assign`, `audit.read`, `audit.read.account` |
| `admin`            | all                                                                    |

The role-by-capability matrix with the in-code enforcement is in [Roles and capabilities](/en/reference/roles-capabilities).

## Keeping this page current

When the status of a feature from this list changes, update its row in both locales (`documentation/reference/implemented-features.md` and `documentation/en/reference/implemented-features.md`). A new admin page appears here together with its `ADMIN_PAGES` entry.
