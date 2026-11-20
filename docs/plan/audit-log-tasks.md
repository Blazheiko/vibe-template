# Журнал важливих дій — покроковий task list

Джерело: [`audit-log-plan.md`](./audit-log-plan.md) (редакція 3 з уточненням T5, рішення Р1–Р14).
Фіча `feat-235`, гілка `feat/audit-log`. Базовий шлях: `packages/`, якщо не вказано інше. Коміт для
посилань: `365c335`.

Одна фіча, одна гілка й PR (правила `AGENTS.md`). Номери T1–T9 збігаються з таблицею задач плану,
T0 і T10 — старт і закриття. Задача або підзадача — один коміт або кілька дрібних. Вона
закінчується зеленим вузьким тестом свого рівня. Позначення тестів:

- `shared/test/*` — `pnpm --filter shared test`;
- `*.spec.ts` — `pnpm --filter backend test` або `pnpm --filter frontend test`;
- `*.pg.test.ts` — `make test-pg`;
- `*.redis.test.ts` — `make test-redis`;
- `frontend/e2e/` — `pnpm --filter frontend test:e2e` (мокований бекенд);
- `frontend/e2e-live/` — `pnpm --filter frontend test:e2e:live` (справжній бекенд).

**Definition of Done:** `make check`; `make test-pg` і `make test-redis` з кількістю виконаних і
пропущених тестів (або посилання на CI-джоби `test-pg`, `test-redis`); `test:e2e` і
`test:e2e:live`; `pnpm docs:build && pnpm docs:verify`; `job:run audit-events-retention` з
`--dry-run` і без нього; ручний прохід golden path. Усе це в `feature-state/feat-235/progress.md` →
Evidence of Completion.

**Правило для всіх точок запису (T4, T5):** подія пишеться лише в гілці, де зміна справді
відбулася, всередині її транзакції, з часом `auditService.stamp(tx)`, узятим після блокування.
Наявна поведінка (коди відповідей, гонки feat-096/097/099/100/233) не змінюється, крім явно
названих місць: прив'язка телефону (T5.5) і порядок читань у промптах і статтях (T4).

## Порядок

T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10.

T1 і T2 незалежні. T4, T5, T6 і T7 залежать лише від T3 і можуть іти в будь-якому порядку. T8
залежить від T6, T9 — від усіх.

---

### T0 · Старт фічі

- [ ] Короткий PR до `main` (гілка `chore/feat-235-start`): `feat-235` → `in_progress`.
- [ ] Гілка `feat/audit-log` від `main`, `feature-state/feat-235/progress.md` (стан, наступний
      крок) і порожній `session-handoff.md`.
- [ ] `./init.sh` зелений, результат у `progress.md`. Якщо червоний — зупинитися й зафіксувати
      команду та вивід.

### T1 · Каталог дій і payload (`shared`) — Р4, Р5, Р6

- [ ] `shared/src/audit/audit-actions.ts`: `AUDIT_ACTIONS` (`const`) з 16 дій першого релізу:
      `user.admin.created`; `auth.password.changed`, `auth.password.reset`,
      `auth.account.claimed`, `auth.phone.linked`, `auth.email.linked`, `auth.oauth.linked`,
      `auth.sign_in_method.unlinked`; `auth.sessions.revoked_all`, `auth.sessions.revoked_others`;
      `kb.article.created`, `kb.article.updated`, `kb.article.deleted`, `kb.screenshot.uploaded`,
      `kb.screenshot.removed`; `ai.prompt.updated`. Для кожної дії: група (`rights`, `sign-in`,
      `sessions`, `kb`, `ai`), `targetType`, допустимі `actorKind`.
- [ ] Типи `AuditAction`, `AuditActorKind` (`user`, `proof_holder`, `system`) і `AuditProof`
      (`email_link`, `sms_code`, `oauth_email_link`, `oauth_provider_email`).
- [ ] Для кожної дії — тип `changes` і `metadata` (таблиця Р4) та функція проєкції. Проєкція
      будує новий об'єкт, перелічуючи поля, і ніколи не розгортає вхідний (`...row`).
- [ ] `diffAllowed(before, after, fields)`: лише змінені поля як `{ from, to }`; без змін —
      `null`.
- [ ] Відбиток `content` статті й промпту: `changed`, `sha256Before`, `sha256After`,
      `charsBefore`, `charsAfter`. Хеш рахує backend (`node:crypto`), у `shared` — лише тип.
- [ ] `AUDIT_PAYLOAD_MAX_BYTES = 8192` і перевірка ключів: рекурсивно, кожен ключ `changes` і
      `metadata` має бути в переліку дії, інакше виняток. Перевірку розміру в байтах
      (`Buffer.byteLength` від серіалізованих `changes` і `metadata`) робить backend (T3).
- [ ] Схеми API для T6: `AuditEventSchema`, `AuditEventsPageSchema` і query-схема фільтрів:
      `action[]`, `group`, `actorUserId`, `targetUserId`, `targetType`, `targetId`, `requestId`,
      `from`, `to`, `cursor`. `from` і `to` — ISO 8601, `cursor` — непрозорий рядок обмеженої
      довжини, невідомі ключі відхиляються (`'+': 'reject'`).
- [ ] Експорт з barrel-файлу `shared`.
- [ ] Тести (`shared/test/`; розмір — у backend-тесті T3):
    - для кожної дії вхід із зайвими полями (`password`, `sessionToken`, `providerEmail`,
      `providerUserId`, `screenshotKey`, `email`, `phone`) — у результаті проєкції їх немає;
    - невідомий ключ у `changes` або `metadata` — виняток;
    - `diffAllowed`: без змін → `null`; `null` ↔ значення; булеві.

### T2 · Таблиця `audit_events` і міграція — Р1, Р2, Р8

- [ ] `backend/src/database/schema.ts`: enum `audit_actor_kind` і таблиця `audit_events` з
      колонками Р1. `occurred_at` — `timestamp NOT NULL` **без default**. `actor_user_id` і
      `target_user_id` — `bigint` **без FK**. `request_id` — `uuid`, `changes` і `metadata` —
      `jsonb`.
- [ ] Індекси Р8, усі з хвостом `occurred_at DESC, id DESC`: без префікса (стрічка), з префіксом
      `target_user_id`, `actor_user_id`, `(target_type, target_id)`, `action`; частковий індекс
      `request_id` з умовою `request_id IS NOT NULL`.
- [ ] `pnpm --filter backend db:generate` → нова папка в `src/drizzle/migrations/` (формат
      Drizzle 1.0). У її `migration.sql` дописати функцію й тригер `audit_events_no_update`
      (`BEFORE UPDATE`, `FOR EACH ROW`, `RAISE EXCEPTION`). Це перший тригер у міграціях, тож
      коментар у SQL пояснює, навіщо він і що snapshot Drizzle його не знає.
- [ ] `relations.ts`: зв'язків немає (без FK), нічого не додавати.
- [ ] PG (`audit-events-schema.pg.test.ts`): міграція застосовується на чисту БД; `UPDATE` рядка
      падає з помилкою тригера; `DELETE` проходить; вставка без `occurred_at` падає.

### T3 · Репозиторій і сервіс — Р3, Р5, Р6, Р7, Р12

- [ ] `repositories/audit/audit-events-repository.ts`, експорт з `repositories/index.ts`:
    - `insert(entries, executor)` — події однієї зміни одним `INSERT`;
    - `list(filters, cursor, limit)` — keyset за `(occurred_at, id)` менше курсора, порядок
      `occurred_at DESC, id DESC`, `LIMIT n + 1`. Курсор бере `occurred_at::text` з SQL, щоб
      мікросекунди не проходили через JS `Date`;
    - `purgeBatch(cutoff, limit, executor)` — `DELETE … WHERE id = ANY(ARRAY(SELECT id …))` з
      умовою `occurred_at < cutoff`, `ORDER BY occurred_at`, `LIMIT n`; повертає кількість;
    - `countPurgeable(cutoff)` — для `dryRun`.
- [ ] `layering.spec.ts`: репозиторій має рівно `insert`, `list`, `purgeBatch`, `countPurgeable`
      (жодного `update`).
- [ ] `services/audit/audit-service.ts`:
    - `stamp(tx)` — `SELECT clock_timestamp()::text`, повертає `AuditStamp`;
    - `record(tx, stamp, actor, events)` — проєкція T1, перевірка ключів, перевірка розміру
      (`AUDIT_PAYLOAD_MAX_BYTES`), перевірка `actorKind` за каталогом, обов'язковий `proof` для
      `proof_holder`, один `insert`;
    - `logCommitted(logger, events)` — після коміту `logger.info` з `action`, `targetType`,
      `targetId`, без `changes` (Р12).
- [ ] `AuditActor` (`kind`, `userId`, `role`, `requestId`, `proof`, `source`) і хелпери в
      `controllers/shared/audit-actor.ts`: `auditActorFrom(context, role)` для `user`,
      `proofHolderActor(context, proof)`, `systemActor('seed')`. Роль адміна — з того самого
      читання, що робить `admin_guard` (передати через контекст, без другого запиту); для інших
      маршрутів — `null` або з рядка, який сервіс уже читає.
- [ ] Unit (`audit-service.spec.ts`, `audit-actor.spec.ts`):
    - `proof_holder` без `proof` — виняток; `actorKind`, не дозволений дією, — виняток;
    - **найгірший розмір** для кожної дії: рядки максимальної довжини схеми з `\u0001`, `\"` і
      `😀`, числа на межах схеми. Кожен варіант ≤ 8192. Очікувані порядки: оновлення статті
      ≈ 4613 байтів, промпт ≈ 2844, створення статті ≈ 2423;
    - payload на 1 байт більший за межу — виняток.
- [ ] PG (`audit-events-repository.pg.test.ts`):
    - кілька подій з рівним `occurred_at` (один `stamp`) і сторінки по 2 — нічого не губиться
      й не повторюється;
    - межі `from` і `to` на мікросекундних значеннях (`from` включно, `to` ні);
    - `stamp`, узятий після `FOR UPDATE` у транзакції, що почалася першою, але чекала
      блокування, більший за `stamp` другої.

### T4 · Промпти й база знань — Р3, Р5

**T4.1 · Промпти**

- [ ] `prompt-repository.ts`: `lockByType(type, tx)` з `FOR UPDATE`; `update(type, data, tx)`
      повертає рядок з `RETURNING`.
- [ ] `prompt-service.update(type, data, actor)` у `withTransaction`: `lockByType` → `stamp` →
      `UPDATE … RETURNING` → diff (`model`, `temperature`, `maxTokens`, `topic`) + відбиток
      `content` → `record`. Порожній diff — без `UPDATE` і без події.
- [ ] Кеш оновлюється рядком з `RETURNING` **після** коміту; повторне читання прибрати.
- [ ] `prompt-controller.ts` передає `actor` (`PUT /prompts/:type`).
- [ ] `prompt-service.spec.ts` зелений (моки під нову сигнатуру).

**T4.2 · Статті**

- [ ] `support-knowledge-repository.ts`: `create`, `update`, `delete` приймають `executor`;
      новий `lockById(id, tx)`; `update` і `delete` повертають рядок з `RETURNING`.
- [ ] `knowledge-base-service` — `create`, `update`, `delete` з `actor` у `withTransaction`: для
      `update` і `delete` спершу `lockById` → `stamp` → зміна з `RETURNING` → diff (`title`,
      `category`, `isActive`, відбиток `content`) → `record`. Порожній diff — без `UPDATE` і без
      події.
- [ ] Переіндексація (`indexArticle`) — після коміту, як зараз. `requireArticle` до транзакції
      лишається лише як швидкий `404`; джерело `before` — заблокований рядок.

**T4.3 · Скриншоти**

- [ ] `replaceScreenshot(id, screenshot, actor)`: у наявній транзакції після `FOR UPDATE` —
      `stamp` і `record` (`kb.screenshot.uploaded` або `kb.screenshot.removed`). У payload лише
      наявність скриншота до й після та `mime`; ключі S3 не потрапляють.
- [ ] Порядок S3 не змінюється: новий об'єкт до транзакції, старий видаляється після коміту.
      Збій `record` відкочує заміну, а новий об'єкт прибирає наявна гілка `isServerRejection`.

**T4.4 · Контролери й тести**

- [ ] `admin-knowledge-base-controller.ts` передає `actor`.
- [ ] PG (`prompt-audit.pg.test.ts`, `kb-audit.pg.test.ts`):
    - атомарність: `record`, що кидає, лишає промпт, статтю й скриншот без змін;
    - гонка (`race-barrier.ts`): дві зміни одного промпту і однієї статті; транзакція, що
      почалася першою, отримує блокування другою. `after` першої застосованої зміни дорівнює
      `before` другої, а `list` за `targetType` і `targetId` повертає їх у порядку застосування;
    - порожній diff не створює події;
    - `content` у payload лише як хеш і довжина.
- [ ] Наявні `kb-embedding-consistency.pg.test.ts`, `knowledge-base-service.spec.ts`,
      `storage-object-replacement.pg.test.ts` зелені.

### T5 · Способи входу, сесії, seed — Р3, Р4, Р6

**T5.1 · Масове відкликання сесій**

- [ ] `authService.logoutAll` і `sessionListService.revokeOthers`: у наявній `withTransaction`
      ротації, лише коли `updateIfSessionToken` повернув рядок, — `stamp` + `record`
      (`auth.sessions.revoked_all` або `auth.sessions.revoked_others`, виконавець `user`).
- [ ] `auth-controller` і `account-sessions-controller` передають `actor`.
- [ ] PG: збій `record` → `500`; **попередній `session_token` чинний** (запит зі старою сесією
      проходить); посилання скидання й SMS-челенджі не погашені. Відмова `session_revoked`
      події не пише.

**T5.2 · Зміна пароля**

- [ ] `changePassword`: у транзакції `changePasswordIfCurrent`, коли рядок повернуто, —
      `auth.password.changed` (`sessionsRevoked: 'others'`).
- [ ] PG: збій `record` лишає старий пароль і токен.

**T5.3 · Підтвердження володіння (`claimLocked`)**

- [ ] `oauthAccountRepository.deleteByUserId` → `DELETE … RETURNING provider`;
      `pushSubscriptionRepository.deleteByUserId` повертає кількість.
- [ ] `ClaimOutcome.effects`: `passwordCleared`, `phoneRemoved`, `oauthRemoved` (провайдери),
      `pushSubscriptionsRemoved` — з видалених рядків і рядка до зміни.
- [ ] Хелпер `claimEvent(outcome, proof)` → подія `auth.account.claimed` або нічого, коли
      `claimed: false`.
- [ ] `oauth-pre-hijack.pg.test.ts` і `account-claim-service.spec.ts` зелені.

**T5.4 · Відновлення пароля**

- [ ] `resetPassword` (посилання): у `apply` `runTokenTransaction` — `stamp`,
      `auth.password.reset` (`proof_holder`, `email_link`, `claimed`) і `claimEvent`.
- [ ] `completePhonePasswordReset`: у `withTransactionResult` після `lockById` —
      `auth.password.reset` (`proof_holder`, `sms_code`).
- [ ] Контролери передають `proofHolderActor(context, proof)` з `requestId`.
- [ ] PG:
    - скидання неперевіреного акаунта з телефоном і двома OAuth-прив'язками пише
      `auth.password.reset` і `auth.account.claimed` з обома провайдерами, з одним `request_id`
      і `occurred_at`;
    - для підтвердженого акаунта `auth.account.claimed` не пишеться;
    - збій `record` лишає посилання чинним і пароль старим.

**T5.5 · Прив'язка телефону (`confirmPhoneLink`) — уточнення T5 плану**

- [ ] Кінець методу перебудувати на `withTransactionResult` (не `withTransaction`):
    1. `userRepository.lockById(userId, tx)`;
    2. під блокуванням: `sessionToken` дорівнює пред'явленому (інакше `sessionRevoked()`),
       номера ще немає (інакше «Phone is already linked to this account»);
    3. `confirmChallenge(challenge, answers, tx)`;
    4. `userRepository.update` номера на заблокованому рядку (з `tx`);
    5. `stamp` + `record` (`auth.phone.linked`, `user`, `proof: 'sms_code'`).
- [ ] Перевірки до транзакції лишаються як швидка відмова; `requireSessionStored` — до
      транзакції, як зараз.
- [ ] `409` від унікального індексу (`isUniqueViolation`) ловиться поза `withTransactionResult`:
      транзакцію вже відкочено, челендж непідтверджений. Оновити коментар feat-100 («the
      challenge stays confirmed»).
- [ ] PG (`phone-link-audit.pg.test.ts`):
    - збій `record` → `500`, номер не прив'язано, `confirmed_at IS NULL`; повтор із тим самим
      кодом прив'язує номер і пише одну подію; спроба першого запиту в лічильнику витрачена;
    - **гонка одного акаунта** (`race-barrier.ts` після попередніх перевірок): два челенджі на
      різні номери. Рівно один номер прив'язано й одна подія; другий запит отримує «already
      linked», його челендж непідтверджений, номер першого не перезаписано;
    - токен ротовано між попередньою перевіркою і транзакцією → `session_revoked`,
      підтвердження відкочено;
    - `409` від унікального індексу лишає челендж непідтвердженим, відповідь та сама.
- [ ] Тести feat-100 оновлюються свідомо; причина — у PR і `progress.md`.

**T5.6 · Прив'язка email, OAuth, відв'язка**

- [ ] Прив'язка email (`apply` у `runTokenTransaction`, `email-verification-service`):
      `auth.email.linked`, виконавець `user` (власник сесії), `proof: 'email_link'`.
- [ ] `confirmLink`: `auth.oauth.linked` (`proof_holder`, `oauth_email_link`, `provider`) і
      `claimEvent`.
- [ ] `linkTrusted`: у `withTransaction` після `lockById` — `auth.oauth.linked`
      (`proof_holder`, `oauth_provider_email`) і `claimEvent`. Лише в гілці `ok`; гілки
      `missing` і `changed` нічого не пишуть. `actor` іде з `handleCallback` через
      `signInWithIdentity`.
- [ ] `sign-in-methods-service.unlink`: `auth.sign_in_method.unlinked` (`method`, `provider`) у
      наявній транзакції.
- [ ] PG за шляхами виконавця: `linkTrusted` — `proof_holder` без `actor_user_id`; `confirmLink`
      — те саме з `oauth_email_link`; прив'язка email — `user` з `actor_user_id` власника сесії;
      відв'язка — `user`. Збій `record` у кожному шляху відкочує зміну, токен листа лишається
      чинним.

**T5.7 · Seed**

- [ ] `drizzle-seed-store.ts`: вставка адміністратора — у транзакції разом із
      `user.admin.created` (`system`, `source: 'seed'`, без `request_id`, роль `null` → `admin`).
      Демо-користувач події не пише.
- [ ] `run-seed.spec.ts`: подія для створеного адміна; для `already_exists` і
      `exists_without_admin_role` — немає.

**T5.8 · Регресії**

- [ ] Наявні PG-тести гонок auth (`one-time-token-race`, `oauth-pre-hijack`,
      `account-sessions-http`, `auth-service.*`) зелені **без правок**, крім feat-100 з T5.5.
- [ ] `make test-redis` зелений (сесії).

### T6 · `GET /admin/audit-events` — Р7

- [ ] Контракт `adminContracts.auditEvents` (`get /admin/audit-events`) у
      `shared/src/contracts/admin.ts`, схеми в реєстрі, `response-schema-guards`.
- [ ] `admin-audit-events-controller.ts`, `audit-events-query-service.ts`,
      `audit-event-transformer.ts`: сторінка 50; `actor` і `targetUser` збагачуються `name` одним
      запитом по `users` для id сторінки; видалений користувач — `deleted: true` з id; email не
      повертається; для `proof_holder` повертається `proof`.
- [ ] Маршрут в окремій групі `/admin` з `session_web`, `csrf_guard`, `auth_guard`,
      `admin_guard`.
- [ ] Курсор — base64url від `occurred_at` (текст із SQL) і `id`; невалідний → `400`.
- [ ] `group` розгортається в набір `action` з каталогу T1.
- [ ] HTTP (`admin-audit-events-http.pg.test.ts`): `401` без сесії, `403` для не-адміна; кожен
      фільтр і їх поєднання; невалідні `cursor`, `from`, `to`, `action`; порядок і сторінки на
      подіях з рівним `occurred_at`.
- [ ] `route-access.spec.ts` і `route-contracts.spec.ts` оновлені й зелені.

### T7 · Задача `audit-events-retention` — Р9

Скіл `scheduled-job`, вимоги «Adding a job» у `documentation/en/backend/scheduler.md`.

- [ ] `config/audit-events-retention.ts`: `AUDIT_EVENTS_RETENTION_DAYS` (за замовчуванням 365,
      мінімум 30) і розмір партії; `configError`; перевірка в `validate-runtime-config.ts`.
- [ ] `audit-events-retention-service.ts`: `purge` з `before`, `dryRun`, `checkpoint`;
      `checkpoint()` безпосередньо перед кожним SQL-кроком; `dryRun` → `countPurgeable`.
- [ ] `scheduler/jobs/audit-events-retention.ts` (`defineJob`, щоденно, `timeout` у межах Р13
      планувальника): `cutoff` обчислюється **один раз** на запуск; за помилки конфігу задача
      відмовляється працювати. Реєстрація в `jobs/index.ts`.
- [ ] `.env.example`: змінна з коментарем.
- [ ] Unit (`audit-events-retention.spec.ts`): `cutoff` з конфігу; `checkpoint` і `dryRun`
      передаються; відмова при помилці конфігу. `jobs/index.spec.ts` зелений.
- [ ] PG (`audit-events-retention.pg.test.ts`):
    - рядки за кілька хвилин по обидва боки `cutoff` (строгість порівняння);
    - малий розмір партії;
    - `checkpoint`, що кидає після першої партії, — наступного запиту немає;
    - `dryRun` рахує ті самі рядки й нічого не видаляє;
    - два перекриті запуски видаляють кожен рядок рівно раз;
    - `EXPLAIN` партії з вимкненими `enable_seqscan` і `enable_sort` знаходить індекс без
      сортування;
    - тригер не заважає `DELETE`.

### T8 · Frontend `/admin/audit-log` — Р10

- [ ] API-клієнт `auditEvents(filters, cursor)` за контрактом T6.
- [ ] `views/admin/AdminAuditLogView.vue`: таблиця (час, виконавець, дія, об'єкт, request ID),
      фільтри Р7 у query-рядку URL (переживають перезавантаження), «Показати ще», стани
      завантаження, порожній і помилки.
- [ ] Розгорнутий рядок: `changes` таблицею «поле / було / стало»; `content` як «змінено» (хеш і
      довжина); `metadata`; копіювання request ID. `proof_holder` — «без входу» з назвою доказу.
- [ ] Назви дій і доказів — у `locales` за ключами `AUDIT_ACTIONS`.
- [ ] Маршрут `admin/audit-log` у `router/index.ts`, пункт у `AdminLayout`.
- [ ] Посилання: у `AdminUsersView` — «Журнал» (`targetUserId`); у `AdminKnowledgeBaseView` —
      «Історія змін» (`targetType=kb_article`, `targetId`).
- [ ] Unit (`views/admin/__tests__/AdminAuditLogView.spec.ts`): фільтри ↔ URL, розгортання,
      «Показати ще» додає сторінку, відображення `proof_holder`.
- [ ] `frontend/e2e/` з моком: сторінка, фільтри, розгортання, «Показати ще».
- [ ] `frontend/e2e-live/audit-log.spec.ts`:
    - адмін змінює статтю в UI бази знань і промпт через `PUT /prompts/:type` (сторінки промптів
      немає) → бачить обидві події зі своїм ім'ям;
    - користувач змінює пароль і натискає «Вийти всюди» → адмін знаходить ці події за
      `targetUserId`.
- [ ] `check-bundle-graph` (ADR 0005) зелений: сторінка — lazy-чанк адмінки.

### T9 · Документація — Р14

- [ ] `documentation/backend/audit-log.md` і `documentation/en/backend/audit-log.md`: модель і
      колонки, каталог дій, типи виконавців і доказів, політика полів і межа 8192, fail closed,
      час `clock_timestamp()` після блокування, API (фільтри, курсор, точність `from` і `to`),
      строк зберігання, межа захисту від власника БД, відсутність IP і контактів. Посилання на
      джерела на GitHub.
- [ ] Сайдбари обох локалей (`documentation/.vitepress/config.ts`), `KEY_PAGES` і `EN_KEY_PAGES`
      (`documentation/scripts/verify-dist.mjs`).
- [ ] `scheduler.md` (таблиці задач і змінних), `configuration.md` (змінна), сторінки auth,
      сесій, AI і бази знань — посилання на журнал; обидві локалі.
- [ ] Сторінка про БД і міграції — нова таблиця й тригер.
- [ ] `pnpm docs:build && pnpm docs:verify`.

### T10 · Перевірка, рев'ю, закриття

- [ ] `make check`; `make test-pg` і `make test-redis` з кількістю виконаних і пропущених;
      `test:e2e`, `test:e2e:live`; `pnpm docs:build && pnpm docs:verify`.
- [ ] Мутації (Р13) — кожна ламає свій тест, результат у `progress.md`:
    - прибрати `record` з будь-якої точки запису;
    - `FOR UPDATE` → звичайне читання;
    - `stamp` до блокування або `now()`;
    - `confirmChallenge` поза транзакцією;
    - `withTransactionResult` → `withTransaction` або прибрати повторну перевірку номера;
    - межа 4096.
- [ ] `job:run audit-events-retention --dry-run` на сидованих старих рядках, потім без
      `--dry-run`: лічильники збігаються.
- [ ] Ручний прохід: змінити статтю, промпт (API), пароль, відв'язати спосіб входу, «Вийти
      всюди» → знайти кожну подію в `/admin/audit-log` за фільтрами й за request ID у логах.
- [ ] `progress.md` → Evidence of Completion; PR `feat/audit-log` → `main`; окремий PR статусу
      `review`.
- [ ] Після рев'ю й мерджу — PR «Mark feat-235 done»: `done`, evidence (PR, CI, лічильники),
      видалити `feature-state/feat-235/`.
