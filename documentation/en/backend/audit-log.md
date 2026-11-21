# Audit log

An admin (and, through them, support) can answer who changed what and when in the sign-in methods of an account, in its sessions (mass revocation), in the knowledge base and in the AI prompts. Each entry has an actor, an action, an object, a time, the request ID and a runtime-checked set of "before/after" values. The log is filtered, readable by roles with the `audit.read.account` permission (in full with `audit.read`, see [Roles and capabilities](/en/reference/roles-capabilities)), holds no secrets, IP addresses or contact data, and old entries are deleted after a configurable time (feat-235).

Sources: the catalog [`shared/src/audit/audit-actions.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/audit/audit-actions.ts), the service [`audit-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/audit/audit-service.ts), the repository [`audit-events-repository.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/repositories/audit/audit-events-repository.ts), the page [`AdminAuditLogView.vue`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/views/admin/AdminAuditLogView.vue).

## The table `audit_events`

| Column           | Type                                | Meaning                                                                  |
| ---------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| `id`             | `bigserial`                         | second part of the order key                                             |
| `occurred_at`    | `timestamp(6)`, no default          | the moment of the change, taken after its row lock; shared by its events |
| `actor_kind`     | enum `user / proof_holder / system` | who did it                                                               |
| `actor_user_id`  | `bigint`, no foreign key            | `user` only; an entry outlives the account                               |
| `actor_role`     | `user_role`                         | the actor's role at the time, `user` only                                |
| `action`         | `varchar(64)`                       | a key of the catalog below                                               |
| `target_type`    | `varchar(32)`                       | `user`, `kb_article`, `llm_prompt`                                       |
| `target_id`      | `varchar(64)`                       | the object id as text (a row id or a prompt type)                        |
| `target_user_id` | `bigint`, no foreign key            | whose account the change concerns                                        |
| `request_id`     | `uuid`                              | the link to the request logs; `NULL` for `system`                        |
| `changes`        | `jsonb`                             | `{ from, to }` of the allowed fields                                     |
| `metadata`       | `jsonb`                             | context: the sign-in method, the provider, the proof, the source         |

Indexes: `(occurred_at, id)` for the feed, the cursor and the retention job; the same tail after `target_user_id`, `actor_user_id`, `(target_type, target_id)` and `action`; a partial index on `request_id`. The migration [`20261120113018_audit_events`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/drizzle/migrations/20261120113018_audit_events/migration.sql) also adds the trigger `audit_events_no_update`: an `UPDATE` of a row fails. `DELETE` is allowed for the retention job. The trigger guards against the application, not against the owner of the database, who can drop it; the template has no separate database role.

## Catalog of actions

| Group    | Action                               | Actor                    | Object       | Content                                                                                         |
| -------- | ------------------------------------ | ------------------------ | ------------ | ----------------------------------------------------------------------------------------------- |
| rights   | `user.admin.created`                 | `system` (`seed`)        | `user`       | `changes.role: { from: null, to: 'admin' }`                                                     |
| rights   | `user.role.changed`                  | `user`, `system` (`cli`) | `user`       | `changes.role: { from, to }`; for `system`, `metadata.source`                                   |
| sign-in  | `auth.password.changed`              | `user`                   | `user`       | `{ sessionsRevoked: 'others' }`                                                                 |
| sign-in  | `auth.password.reset`                | `proof_holder`           | `user`       | `{ proof: 'email_link' \| 'sms_code', claimed }`                                                |
| sign-in  | `auth.account.claimed`               | `proof_holder`           | `user`       | `{ proof, passwordCleared, phoneRemoved, oauthRemoved: [providers], pushSubscriptionsRemoved }` |
| sign-in  | `auth.phone.linked`                  | `user`                   | `user`       | `{ method: 'phone', proof: 'sms_code' }`                                                        |
| sign-in  | `auth.email.linked`                  | `user`                   | `user`       | `{ method: 'email', proof: 'email_link' }`                                                      |
| sign-in  | `auth.oauth.linked`                  | `proof_holder`           | `user`       | `{ method: 'oauth', provider, proof: 'oauth_email_link' \| 'oauth_provider_email' }`            |
| sign-in  | `auth.sign_in_method.unlinked`       | `user`                   | `user`       | `{ method, provider }`                                                                          |
| sessions | `auth.sessions.revoked_all`          | `user`                   | `user`       | none                                                                                            |
| sessions | `auth.sessions.revoked_others`       | `user`                   | `user`       | none                                                                                            |
| kb       | `kb.article.created/updated/deleted` | `user`                   | `kb_article` | `title`, `category`, `isActive`; the text as a fingerprint                                      |
| kb       | `kb.screenshot.uploaded/removed`     | `user`                   | `kb_article` | `{ screenshot: { from, to } }` (presence only), `mime`                                          |
| ai       | `ai.prompt.updated`                  | `user`                   | `llm_prompt` | `model`, `temperature`, `maxTokens`, `topic`; the text as a fingerprint                         |

`auth.account.claimed` is written next to the event that caused the claim (a reset by link, an OAuth link), with the same `request_id` and `occurred_at`. `user.role.changed` is written by [`role-assignment-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/role-assignment-service.ts) in the transaction of the role change; `PATCH /admin/users/:id/role` (actor `user`) and the `user:set-role` CLI (actor `system`, source `cli`, see [Scripts](/en/reference/scripts)) call it. Not yet recorded: registration, the revocation of one session, failed attempts.

## Actors and proofs

- `user`: a request with a signed-in session; `actor_user_id` is the session's user. An action that also needs a one-time proof records it in `metadata.proof` (an e-mail link opened from a session of the account, an SMS code of a challenge bound to the session).
- `proof_holder`: no session of the account, only a proof. `actor_user_id` is `NULL`, the proof is required: `email_link` (password reset by link), `sms_code` (password reset by SMS), `oauth_email_link` (an OAuth link confirmed by mail in the browser of the sign-in), `oauth_provider_email` (the provider proved the address).
- `system`: the seed or a CLI; `request_id` is `NULL`, `metadata.source` names it: `seed` or `cli` (`AUDIT_SYSTEM_SOURCES`).

A role change through `PATCH /admin/users/:id/role` is recorded with the `user` actor (its role read under the role-change lock) and the request's `request_id`; through the CLI, with the `system` actor and `metadata.source = cli`.

The catalog also lists the proofs each action accepts, and `record` refuses anything else: a proof holder needs one of them, `auth.phone.linked` needs `sms_code`, `auth.email.linked` needs `email_link`, and an action without proofs refuses one. A `user` or `proof_holder` actor always carries the request ID: the services take the actor (or the request) as a required parameter.

## What is stored

Every action names the fields it keeps; a projection never copies a row. The texts of an article and of a prompt go in as `{ changed, sha256Before, sha256After, charsBefore, charsAfter }`. **Never** stored: password hashes, tokens, codes, session ids, S3 keys, e-mail addresses, phone numbers, IP addresses, the identifiers or addresses at the provider. Before the insert the payload passes a key check (every key at every depth must be in the catalog of the action) and a size check: the serialized `{ changes, metadata }` is at most **8192 bytes**. The bound comes from the worst case: a control character takes 6 bytes in JSON (`\u0001`), so an article update with the longest title and category takes about 4.6 KB. A test builds the worst case of every action.

An edit that changes nothing (the same values as the row) runs no `UPDATE` and writes no event: `updatedAt`, the content version and the embedding of an article stay.

## Fail closed and the time of an event

Every event is written in the transaction of the change it records. If the insert fails, the change rolls back and the client gets `500`: the previous session token stays valid after a failed logout-all, the mailed link stays usable after a failed reset, the SMS code of a phone link stays unconfirmed. A phone link confirms its code in that same transaction, under the lock of the user row; the session and the absence of a number are checked again under it.

`occurred_at` is `clock_timestamp()` read after the statement that locks the changed row, not `now()` (the start of the transaction). The history of one object therefore lists its changes in the order they were applied. Between different objects it is just the database clock.

After the commit each event is logged at `info` as `audit event` with `action`, `targetType` and `targetId` (no `changes`). For HTTP it is the request logger, so an event is also found in the logs by its request ID.

## API

`GET /api/admin/audit-events` (`session_web`, `csrf_guard`, `auth_guard`, `can:audit.read.account`), contract `adminContracts.auditEvents`.

The scope depends on the role ([`audit-events-query-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/admin/audit-events-query-service.ts)): with the `audit.read` permission (`user_admin`, `admin`) the whole log is visible. Without it (`support_operator`) only the actions of the `sign-in` and `sessions` groups with `targetType = user` are visible; the query is narrowed before the cursor and the limit, so a page holds no other rows. An explicit filter outside this scope (`group`, any one `action`, `targetType`) is `403 forbidden` `Access denied`.

| Query                    | Meaning                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `action`                 | repeatable: `?action=a&action=b`                                           |
| `group`                  | `rights`, `sign-in`, `sessions`, `kb`, `ai`; with `action`, both must hold |
| `actorUserId`            | the actor                                                                  |
| `targetUserId`           | the account the change concerns                                            |
| `targetType`, `targetId` | the object                                                                 |
| `requestId`              | one request                                                                |
| `from`, `to`             | ISO 8601; `occurred_at >= from`, `occurred_at < to`                        |
| `cursor`                 | the `nextCursor` of the previous page                                      |

Pages of 50, newest first by `(occurred_at, id)`; no total is counted. The cursor carries `occurred_at` as PostgreSQL prints it, so microseconds are not lost in a JS `Date`; an invalid cursor answers `400`, as do a user id PostgreSQL's `bigint` cannot hold and a cursor with a date that does not exist (a malformed query is `422`). `from` and `to` have millisecond precision: `from` includes its whole millisecond, `to` excludes its own. The actor and the account get their names from one read of `users`; a deleted account comes as `deleted: true` with its id. No e-mail is returned.

## Retention

The scheduler job `audit-events-retention` (daily at 04:00 UTC) deletes events older than `AUDIT_EVENTS_RETENTION_DAYS` (default 365, at least 30) in batches of `AUDIT_EVENTS_PURGE_BATCH_SIZE` (default 1000). The cut-off is computed once per run; two runs at once delete every row once. See [Background jobs](/en/backend/scheduler).

```bash
pnpm --filter backend job:run audit-events-retention --dry-run
```

## The admin page

`/admin/audit-log` (permission `audit.read.account`): the table (time, actor, action, object, request ID), the filters in the address of the page (several actions at once), "Load more". Without `audit.read` the filters offer only the `sign-in` and `sessions` groups and the `user` object type. An answer to a page asked for before the filters changed is dropped. A row opens its changes as field / was / became and the copy button of the request ID; a proof holder shows as "without sign-in" with its proof. The user list links to the log of an account, the knowledge base to the history of an article (only with `audit.read`).
