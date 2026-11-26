# feat-264 progress: Branded Ids Remaining Domains

Plan: `docs/plan/branded-types-plan.md` (rev. 5), tasks T21–T26 in `docs/plan/branded-types-tasks.md` (v2.1).
Branch: `feat/branded-ids-domains` (started stacked on feat-263; `main` merged after #843 and #845).

## State

- T22 Push: `PushSubscriptionId`, `PushNotificationLogId` on `push_subscriptions` / `push_notification_logs` (and the
  `subscription_id` FK). `push-subscription-repository`: `findByIdAndUserId` → `findForUser(userId, id)`;
  `update`, `updateByEndpoint`, `deactivate`, `touchLastUsed`, `delete`, `getLogsBySubscriptionId` take the owner
  first; `push-notification-log-repository` `countsBySubscription`, `latestBySubscriptionIds` too; the statistics
  service calls them in that order. No method of these files takes `userId` second.
- T23 Notifications: `NotificationId` (`notifications.id`); repository, center service and controller
  (`parseNotificationId` for the path id, `before` and `upTo`).
- T24 Support, AI, admin, audit: `SupportArticleId`, `SupportMessageId`, `LlmSystemPromptId` (and the
  `llm_system_prompt_id` FK), `LlmTextUsageId`, `AuditEventId`; `decodeAuditCursor` returns an `AuditEventId` through
  `parseAuditEventId`; `audit_events.target_id` / `request_id` stay unbranded. The raw SQL of the knowledge-base search
  brands its ids with `asSupportArticleId`; the support history `before` (checked by its schema) with
  `asSupportMessageId`.
- T25: transformers of these domains use `toEntityId`; `controllers/shared/parse-id.ts` and its spec are removed (no
  caller left); its cases moved to `app/domain/ids.spec.ts` against the per-brand constructors. Type tests in
  `app/shared-brands.spec.ts` for swapped push ids. Docs: `backend/controllers.md` (uk + en) names the constructors.

## Evidence of Completion

- `make check`: exit 0 after merging `main` (backend 3892, frontend 1029, landing 103, eslint rules 12 tests passed;
  `check-bundle-graph: 762 modules, no schema and no validator library`).
- `pnpm --filter backend db:generate`: "No schema changes, nothing to migrate".
- `make test-pg` / `make test-redis`: CI jobs of the implementation PR (links added after the run).
- Manual golden path: not run against a live app (no local database of this project); push, notifications, support
  and the audit log are covered by their HTTP PG suites in CI.

## Notes for Next Session

After the merge: "Mark feat-264 done". Next by the task list: feat-265 (T27, secrets by state).
