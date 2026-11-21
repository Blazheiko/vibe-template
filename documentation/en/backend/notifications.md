# Notification center

Every notification of a user is stored in the application first, and only then pushed under the user's preferences. The history is on every device, also when push is closed or never allowed; unread notifications are marked and counted in the header; a click, in the list or in a push, opens the object and marks the notification read on every device. The account page has the push setting of each category; mandatory channels are shown but cannot be turned off (feat-236).

Sources: the catalog [`shared/src/notifications/catalog.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/notifications/catalog.ts), the params schemas [`schemas/notifications/params.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/notifications/params.ts), the delivery [`notification-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/notifications/notification-service.ts), the API [`notification-center-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/notifications/notification-center-service.ts), the store [`stores/notifications.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/stores/notifications.ts).

## Guarantee: best effort

The row, the signal and the push are written in the background after the business change has committed, like the push before. If the process stops before the insert, the event reaches neither the history nor push. If the insert fails, the push still goes (to the plain link of the kind) and the history has no entry. A complete history needs the event written in the transaction of the change (durable delivery, not part of this feature). Security mails are a separate flow at their call sites: a notification never starts or stops them.

::: warning Deployment
The migration of this feature drops a column the previous version of the server still reads, and old tabs get a `422` for the `notificationTypes` field. The rollout order is in [Deployment → Database in production](/en/backend/deployment#database-in-production).
:::

## Tables

`notifications` (migration [`20261120170831_notification_center`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/drizzle/migrations/20261120170831_notification_center/migration.sql)):

| Column       | Type                            | Meaning                                       |
| ------------ | ------------------------------- | --------------------------------------------- |
| `id`         | `bigserial`                     | a string in the API; also the page cursor     |
| `user_id`    | `bigint`, FK `users`, `cascade` | deleting the account deletes its history      |
| `category`   | `varchar(32)`, `CHECK IN (…)`   | `security`, `support`                         |
| `kind`       | `varchar(64)`, `CHECK IN (…)`   | a key of the catalog                          |
| `params`     | `jsonb`                         | only the keys of the kind, at most 1024 bytes |
| `link`       | `varchar(512)`, starts with `/` | the page it opens, or `NULL`                  |
| `created_at` | `timestamp`                     |                                               |
| `read_at`    | `timestamp`                     | `NULL`: unread                                |

Indexes: `(user_id, id DESC)` for pages, a partial one with `WHERE read_at IS NULL` for the count and the unread filter, `(created_at)` for retention.

`notification_preferences`: `(user_id, category, channel)` primary key, `enabled`, `updated_at`. No row means the default of the catalog.

## Catalog of kinds

The text is not stored: the client builds it from `kind` and `params` in the language of the interface (`notifications.kinds.<kind with _ for .>` in the locales). The push and the mails stay in English on the server ([`notification-push-texts.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/notifications/notification-push-texts.ts)).

| Kind                        | Category   | `params`       | `link`              | Mail (at the call site, unchanged)                          |
| --------------------------- | ---------- | -------------- | ------------------- | ----------------------------------------------------------- |
| `security.new_sign_in`      | `security` | `{ device }`   | `/account#sessions` | confirmed address, not a familiar device, hourly budget     |
| `security.method_added`     | `security` | `{ provider }` | `/account`          | the account's address                                       |
| `security.method_removed`   | `security` | `{ provider }` | `/account`          | none                                                        |
| `security.password_changed` | `security` | `{}`           | `/account`          | none                                                        |
| `security.password_reset`   | `security` | `{}`           | `/account`          | the reset notice                                            |
| `security.logout_all`       | `security` | `{}`           | `/account`          | none                                                        |
| `security.session_revoked`  | `security` | `{ device? }`  | `/account#sessions` | none                                                        |
| `security.account_claimed`  | `security` | `{}`           | `/account`          | the reset notice when the claim came through an email reset |
| `support.reply`             | `support`  | `{}`           | `/support`          | none                                                        |

`device` is a label such as "Chrome on macOS", `provider` an OAuth provider id. No IP, email, phone, User-Agent or session id is stored: the details of a sign-in stay in the session list and in the mail.

## Channels and preferences

| Category   | In the app | Push             | Email                            |
| ---------- | ---------- | ---------------- | -------------------------------- |
| `security` | always     | configurable, on | locked on (where the kind mails) |
| `support`  | always     | configurable, on | none                             |

A push of a category the user turned off reaches no device. If the preferences cannot be read the push is skipped, not sent under the default: the default could override a stored `false`. The push toggle of the account page is about the subscription of this device; the preferences are about categories. The test push ignores them.

## API

All routes are in a group with `session_web`, `csrf_guard` and `auth_guard`; each is bound to the user of the session.

| Route                             | Answer                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /notifications`              | `{ items, next, unreadCount }`; `unread=1`, `before=<id>`, `limit` 1–50 (default 20), newest first |
| `GET /notifications/unread-count` | `{ unreadCount }`, capped at 100 (the client shows "99+")                                          |
| `POST /notifications/:id/read`    | `{ link, unreadCount }`; idempotent: one read already answers the same link                        |
| `POST /notifications/read-all`    | `{ upTo }` → `{ unreadCount }`: every notification with `id <= upTo`, older pages included         |
| `GET /notifications/preferences`  | `{ preferences: [{ category, channel, enabled, locked }] }`                                        |
| `PUT /notifications/preferences`  | `{ category, channel, enabled }` → the matrix                                                      |

- A notification of another user, a missing one, a malformed id and one past the PostgreSQL `bigint` range are the same `404`: existence is not revealed.
- A `before` or `upTo` past `bigint` is `400` (`invalid_cursor`, `invalid_up_to`); a `limit` outside 1–50 is the `422` of validation. Ids are checked before any query.
- A locked channel or one the category does not have is `400` with `reason` `channel_locked` or `channel_unavailable`.
- `read-all` guarantees `id <= upTo`, not "only the ones shown": `bigserial` orders ids by allocation, not by commit, so a concurrent insert with a smaller id committed later is marked too.
- The count is `COUNT(*)` over a subquery with `LIMIT 100` on the partial index.

## Real time

Two events of the [user event bus](/en/backend/websocket), both with an empty payload: `notifications_changed` (an insert, a read, a read-all) and `notification_preferences_changed`. A signal carries no value on purpose: the bus delivers locally and through Redis by two independent paths, so a late count could overwrite a newer answer. The client reads again on a signal and at recovery points, since the bus does not replay and the retention job sends no signal: every `ws_ready`, the tab shown again, a panel or the history page opened. Reads close together are joined (300 ms), a read asked for during one in flight runs once more after it, an older answer is dropped, and so is any answer for the previous account.

## Opening a notification

The frontend route `/notifications/:id/open` calls `POST …/read` and replaces itself with the `link` of the answer (with its fragment; the page scrolls to the section once it appears). Without a link it goes to `/notifications`; a `404` goes there with "no longer exists"; another error with an error notice, and the read state is read again (the server may have committed the read). Without a session the router sends the user to sign in and back. A push opens this route when its notification was stored; otherwise it opens the link of the kind.

The service worker keeps its wider rule ([`resolveNotificationTarget`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/notification-target.ts): a same-origin URL or a path); what the server stores is stricter (`isNotificationLink`: one leading `/`, no scheme or host).

## Retention

The [scheduler](/en/backend/scheduler) job `notifications-retention` runs daily at 04:30 UTC and deletes notifications older than `NOTIFICATIONS_RETENTION_DAYS` (default 90, at least 7), read or not, in batches of `NOTIFICATIONS_PURGE_BATCH_SIZE` (default 1000).

## Adding a kind

1. Add it to `NOTIFICATION_KINDS` and `NotificationParamsMap` in `shared/src/notifications/catalog.ts` and its schema to `NotificationParamsSchemas` (a compile-time check keeps the two in line).
2. Add its push text to `notification-push-texts.ts` and its title and body to the three locales (a test fails without them).
3. Generate a migration: the `CHECK` of `notifications.kind` is built from the catalog.
4. Call `notificationService.notify(userId, kind, params)` after the change has committed. A new category also needs its channel policy in `NOTIFICATION_CHANNEL_POLICY` and a name in the locales.
