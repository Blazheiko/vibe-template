# Архів планів

Виконані плани, на які досі посилаються ADR, security-документи, публічна документація (`documentation/`) або коментарі в коді. Їх зберігають як запис рішень; у роботу вони не беруться, і їх не оновлюють разом з кодом, тож номери рядків і шляхи в них можуть застаріти.

Інші виконані плани видалено (прибирання 2026-11-17); їх можна знайти в історії git, наприклад на коміті [`33841b3`](https://github.com/Blazheiko/vibe-template/tree/33841b3/docs/plan).

| План                                                                                               | Хто посилається                                                |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [`code-issues-found-during-docs.md`](./code-issues-found-during-docs.md)                           | `documentation/` (workflow, roles-capabilities, observability) |
| [`oauth-pre-hijack-plan.md`](./oauth-pre-hijack-plan.md)                                           | `documentation/backend/oauth.md`, `security.md`, PG-тест       |
| [`code-review-2026-11-03-plan.md`](./code-review-2026-11-03-plan.md)                               | `documentation/backend/auth.md`                                |
| [`http-body-limits-plan.md`](./http-body-limits-plan.md)                                           | `documentation/backend/request-lifecycle.md`, security review  |
| [`http-body-limits-original-plan.md`](./http-body-limits-original-plan.md)                         | `documentation/backend/request-lifecycle.md`                   |
| [`strip-response-fields-plan.md`](./strip-response-fields-plan.md)                                 | коментарі в коді бекенду                                       |
| [`ws-async-message-validation-plan.md`](./ws-async-message-validation-plan.md)                     | коментарі в коді бекенду і `shared`                            |
| [`error-handling-fix-plan.md`](./error-handling-fix-plan.md)                                       | ADR 0004                                                       |
| [`code-review-2026-11-10-plan.md`](./code-review-2026-11-10-plan.md)                               | ADR 0005                                                       |
| [`code-review-2026-11-10-report.md`](./code-review-2026-11-10-report.md)                           | ADR 0005, security review                                      |
| [`ws-contracts-tasks.md`](./ws-contracts-tasks.md)                                                 | ADR 0006                                                       |
| [`security-review-2026-11-12-plan.md`](./security-review-2026-11-12-plan.md)                       | `docs/security/security-review-2026-11-12*.md`                 |
| [`security-review-2026-11-12-follow-ups-plan.md`](./security-review-2026-11-12-follow-ups-plan.md) | `docs/security/security-review-2026-11-12-follow-ups.md`       |
| [`anonymous-session-flood-plan.md`](./anonymous-session-flood-plan.md)                             | security review                                                |
| [`docker-hardening-plan.md`](./docker-hardening-plan.md)                                           | security review                                                |
