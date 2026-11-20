# Журнал важливих дій — покроковий task list

**Редакція 2** (за рев'ю редакції 1): оновлення без змін не робить `UPDATE` (T4); новий об'єкт S3
прибирається за будь-якого відомого відкату (T4.3); лог після коміту — вимога для кожної точки
запису; перевірка порядку через HTTP — окремий крок T6a; T8 залежить від T4 і T5; матриця
позитивних тестів, щоб кожна заявлена мутація справді ламала тест; `countPurgeable` узгоджено з
планом.

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

**Правило для всіх точок запису (T4, T5):**

1. Подія пишеться лише в гілці, де зміна справді відбулася, всередині її транзакції, з часом
   `auditService.stamp(tx)`, узятим після блокування.
2. Після коміту — `auditService.logCommitted(actor.logger, events)`. Для HTTP `actor.logger` —
   логер запиту з `requestId`. Seed логує після завершення своєї зовнішньої транзакції
   (`db/seed.ts:56`). Після відкату рядка в лозі немає.
3. Точка запису має позитивний тест на рівно одну очікувану подію й тест відкату (матриця нижче).

Наявна поведінка (коди відповідей, гонки feat-096/097/099/100/233) не змінюється, крім явно
названих місць: прив'язка телефону (T5.5) і порядок читань у промптах і статтях (T4).

## Порядок

T0 → T0 → T1 → T2 → T3 → T4 → T5 → T6 → T6a → T7 → T8 → T9 → T10.

| Задача | Залежить від |
| ------ | ------------ |
| T1, T2 | T0           |
| T3     | T1, T2       |
| T4, T5 | T3           |
| T6, T7 | T3           |
| T6a    | T4, T6       |
| T8     | T4, T5, T6   |
| T9     | T4–T8        |
| T10    | усі          |

T8 залежить від T4 і T5, бо live e2e чекає справжніх подій від цих точок запису.

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
- [ ] `AuditActor` (`kind`, `userId`, `role`, `requestId`, `proof`, `source`, `logger`) і хелпери в
      `controllers/shared/audit-actor.ts`: `auditActorFrom(context, role)` для `user`,
      `proofHolderActor(context, proof)`, `systemActor('seed')`. Роль адміна — з того самого
      читання, що робить `admin_guard` (передати через контекст, без другого запиту); для інших
      маршрутів — `null` або з рядка, який сервіс уже читає.
- [ ] Unit (`audit-service.spec.ts`, `audit-actor.spec.ts`):
    - `proof_holder` без `proof` — виняток; `actorKind`, не дозволений дією, — виняток;
    - **найгірший розмір** для кожної дії: рядки максимальної довжини схеми з `\u0001`, `\"` і
      `😀`, числа на межах схеми. Кожен варіант ≤ 8192. Очікувані порядки: оновлення статті
      ≈ 4613 байтів, промпт ≈ 2844, створення статті ≈ 2423;
    - payload на 1 байт більший за межу — виняток;
    - `logCommitted` пише `action`, `targetType`, `targetId` і `requestId` логера, без `changes`.
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
- [ ] `prompt-service.update(type, data, actor)` у `withTransaction`:
    1. `lockByType`;
    2. порівняти запропоновані значення із заблокованим рядком і лишити лише ті, що відрізняються;
       якщо не лишилось нічого — повернути поточний рядок без `UPDATE` і без події;
    3. `stamp` → `UPDATE … RETURNING` лише змінених полів;
    4. diff між заблокованим рядком і `RETURNING` (`model`, `temperature`, `maxTokens`, `topic`)
        - відбиток `content` → `record`.
- [ ] Після коміту: кеш оновлюється рядком з `RETURNING` (повторне читання прибрати) і
      `logCommitted`.
- [ ] `prompt-controller.ts` передає `actor` (`PUT /prompts/:type`).
- [ ] `prompt-service.spec.ts` зелений (моки під нову сигнатуру).

**T4.2 · Статті**

- [ ] `support-knowledge-repository.ts`: `create`, `update`, `delete` приймають `executor`;
      новий `lockById(id, tx)`; `update` і `delete` повертають рядок з `RETURNING`.
- [ ] `knowledge-base-service` — `create`, `update`, `delete` з `actor` у `withTransaction`:
    - `create`: `stamp` → `INSERT … RETURNING` → `record` (`after`);
    - `delete`: `lockById` → `stamp` → `DELETE … RETURNING` → `record` (`before`);
    - `update`: `lockById` → порівняння із заблокованим рядком, лишаються лише поля, що
      відрізняються; якщо нічого — поточний рядок без `UPDATE` і без події. Інакше `stamp` →
      `UPDATE … RETURNING` лише змінених полів → diff (`title`, `category`, `isActive`, відбиток
      `content`) → `record`.
- [ ] `textChanged` у репозиторії (зростання `contentVersion`, скидання embedding, feat-114)
      рахується з полів, що справді змінились, а не з присутності `title` чи `content` у запиті.
- [ ] Після коміту — `logCommitted` і переіндексація (`indexArticle`), лише якщо текст справді
      змінився. `requireArticle` до транзакції
      лишається лише як швидкий `404`; джерело `before` — заблокований рядок.

**T4.3 · Скриншоти**

- [ ] `replaceScreenshot(id, screenshot, actor)`: у наявній транзакції після `FOR UPDATE` —
      `stamp` і `record` (`kb.screenshot.uploaded` або `kb.screenshot.removed`). У payload лише
      наявність скриншота до й після та `mime`; ключі S3 не потрапляють.
- [ ] Порядок S3 не змінюється: новий об'єкт до транзакції, старий видаляється після коміту.
- [ ] Відкат: `isServerRejection` бачить лише відмову PostgreSQL. Виняток із нашого коду (`record`,
      перевірка payload) у цю гілку не потрапляє, і новий об'єкт лишився б у S3. Тому транзакція
      ставить прапорець `reachedCommit` останньою інструкцією перед поверненням:
    - виняток при `reachedCommit = false` — `COMMIT` не надсилався, відкат відомий → прибрати
      новий об'єкт;
    - `reachedCommit = true` і `isServerRejection` — PostgreSQL відхилив `COMMIT` → прибрати;
    - `reachedCommit = true` без відповіді — результат `COMMIT` невідомий → об'єкт лишається
      (feat-130), попередження в лог.
- [ ] Після коміту — `logCommitted`, потім видалення старого об'єкта.

**T4.4 · Контролери й тести**

- [ ] `admin-knowledge-base-controller.ts` передає `actor`.
- [ ] PG (`prompt-audit.pg.test.ts`, `kb-audit.pg.test.ts`):
    - атомарність: `record`, що кидає, лишає промпт, статтю й скриншот без змін;
    - гонка (`race-barrier.ts`): дві зміни одного промпту і однієї статті; транзакція, що
      почалася першою, отримує блокування другою. `after` першої застосованої зміни дорівнює
      `before` другої, а `list` за `targetType` і `targetId` повертає їх у порядку застосування
      (перевірка через HTTP — T6a);
    - оновлення без змін (ті самі значення, що в рядку): ні `UPDATE`, ні події; `updatedAt` той
      самий, для статті — той самий `contentVersion` і embedding;
    - зміна лише `category` статті не скидає embedding і не збільшує `contentVersion`;
    - `content` у payload лише як хеш і довжина;
    - скриншот з in-memory S3 (як `storage-object-replacement.pg.test.ts`): `record`, що кидає, —
      рядок з попереднім ключем і **нового об'єкта в S3 немає**; збій `COMMIT` без відповіді —
      об'єкт лишається; успіх — новий ключ у рядку, старий об'єкт видалено;
    - лог: успішна зміна пише один рядок `audit event` з `requestId`, відкат — жодного.
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
    - SMS-скидання пише рівно одну `auth.password.reset` з `proof_holder` і `sms_code`;
    - збій `record` лишає посилання чинним і пароль старим; для SMS — челендж непідтверджений.

**T5.5 · Прив'язка телефону (`confirmPhoneLink`) — уточнення T5 плану**

- [ ] Кінець методу перебудувати на `withTransactionResult` (не `withTransaction`):
    1. `userRepository.lockById(userId, tx)`;
    2. під блокуванням: `sessionToken` дорівнює пред'явленому (інакше `sessionRevoked()`),
       номера ще немає (інакше «Phone is already linked to this account»);
    3. `confirmChallenge(challenge, answers, tx)`;
    4. `userRepository.update` номера на заблокованому рядку (з `tx`);
    5. `stamp` + `record` (`auth.phone.linked`, `user`, `proof: 'sms_code'`). Якщо оновлення
       не повернуло рядок — `Result.err`, а не виняток: транзакцію відкочує
       `withTransactionResult`.
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
    - `409` від унікального індексу лишає челендж непідтвердженим, відповідь та сама;
    - **відмова після підтвердження**: оновлення номера (підмінений репозиторій) не повертає
      рядка після `confirmChallenge` → `Result.err`, челендж непідтверджений. Це єдиний сценарій,
      що ловить мутацію `withTransactionResult` → `withTransaction`: відмови під блокуванням
      стаються до підтвердження, а `409` і збій `record` кидають винятки, які відкочують обидва
      варіанти;
    - успіх пише рівно одну `auth.phone.linked`.
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

- [ ] `drizzle-seed-store.ts`: вставка адміністратора й `user.admin.created` (`system`,
      `source: 'seed'`, без `request_id`, роль `null` → `admin`) — у тій самій зовнішній
      транзакції seed (`db/seed.ts:56`), через `tx`, який store уже отримує. Демо-користувач події
      не пише.
- [ ] `runSeed` повертає події у звіті; `db/seed.ts` викликає `logCommitted` після завершення
      `db.transaction`, а не всередині.
- [ ] `run-seed.spec.ts`: подія для створеного адміна; для `already_exists` і
      `exists_without_admin_role` — немає. Збій зовнішньої транзакції — ні адміна, ні події, ні
      рядка в лозі.

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

### T6a · Порядок через API — Р7, Р13 (після T4 і T6)

- [ ] PG/HTTP (`audit-order-http.pg.test.ts`): гонка (`race-barrier.ts`) двох змін одного промпту
      і двох змін однієї статті; транзакція, що почалася першою, отримує блокування другою.
      `GET /admin/audit-events?targetType=…&targetId=…` повертає події в порядку застосування
      змін (новіша першою), `after` застосованої першою дорівнює `before` другої.
- [ ] Ловить мутацію «`stamp` до блокування або `now()`» на рівні API.

### Матриця точок запису

Кожен рядок — позитивний тест (рівно одна очікувана подія з правильними `actorKind`, `proof`,
`target`) і тест відкату (збій `record` → зміни немає, події й рядка в лозі немає). Без
позитивного тесту мутація «прибрати `record`» у цій точці нічого не ламає.

| Точка запису                    | Подія                              | Задача |
| ------------------------------- | ---------------------------------- | ------ |
| `logoutAll`                     | `auth.sessions.revoked_all`        | T5.1   |
| `revokeOthers`                  | `auth.sessions.revoked_others`     | T5.1   |
| `changePassword`                | `auth.password.changed`            | T5.2   |
| `resetPassword`, підтверджений  | `auth.password.reset`              | T5.4   |
| `resetPassword`, неперевірений  | `auth.password.reset` + `claimed`  | T5.4   |
| `completePhonePasswordReset`    | `auth.password.reset` (`sms_code`) | T5.4   |
| `confirmPhoneLink`              | `auth.phone.linked`                | T5.5   |
| прив'язка email                 | `auth.email.linked`                | T5.6   |
| `confirmLink`                   | `auth.oauth.linked` (+ `claimed`)  | T5.6   |
| `linkTrusted`, підтверджений    | `auth.oauth.linked`                | T5.6   |
| `linkTrusted`, неперевірений    | `auth.oauth.linked` + `claimed`    | T5.6   |
| `unlink`                        | `auth.sign_in_method.unlinked`     | T5.6   |
| seed                            | `user.admin.created`               | T5.7   |
| `knowledge-base-service.create` | `kb.article.created`               | T4.2   |
| `knowledge-base-service.update` | `kb.article.updated`               | T4.2   |
| `knowledge-base-service.delete` | `kb.article.deleted`               | T4.2   |
| `uploadScreenshot`              | `kb.screenshot.uploaded`           | T4.3   |
| `deleteScreenshot`              | `kb.screenshot.removed`            | T4.3   |
| `prompt-service.update`         | `ai.prompt.updated`                | T4.1   |

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
- [ ] Мутації (Р13) — кожна ламає названий тест, результат у `progress.md`:

    | Мутація                                            | Тест, що падає                             |
    | -------------------------------------------------- | ------------------------------------------ |
    | прибрати `record` з точки запису                   | позитивний тест цієї точки (матриця)       |
    | `FOR UPDATE` → звичайне читання                    | гонка T4.4 (`after` ≠ `before`)            |
    | `stamp` до блокування або `now()`                  | порядок T6a                                |
    | `confirmChallenge` поза транзакцією                | повтор SMS-коду після збою `record` (T5.5) |
    | `withTransactionResult` → `withTransaction`        | відмова після підтвердження (T5.5)         |
    | прибрати повторну перевірку номера                 | гонка двох номерів (T5.5)                  |
    | `UPDATE` без порівняння з рядком                   | оновлення без змін, `updatedAt` (T4.4)     |
    | прибирати новий об'єкт лише за `isServerRejection` | `record`, що кидає, — об'єкт у S3 (T4.4)   |
    | `logCommitted` усередині транзакції                | тест відкату: рядок у лозі (T4.4, T5.7)    |
    | межа 4096                                          | найгірший розмір (T3)                      |

- [ ] `job:run audit-events-retention --dry-run` на сидованих старих рядках, потім без
      `--dry-run`: лічильники збігаються.
- [ ] Ручний прохід: змінити статтю, промпт (API), пароль, відв'язати спосіб входу, «Вийти
      всюди» → знайти кожну подію в `/admin/audit-log` за фільтрами й за request ID у логах.
- [ ] `progress.md` → Evidence of Completion; PR `feat/audit-log` → `main`; окремий PR статусу
      `review`.
- [ ] Після рев'ю й мерджу — PR «Mark feat-235 done»: `done`, evidence (PR, CI, лічильники),
      видалити `feature-state/feat-235/`.
