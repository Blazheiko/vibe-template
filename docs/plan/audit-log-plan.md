# Журнал важливих дій — план реалізації

**Статус: погоджено власником**, редакція 2 (2026-11-20). Пункт 3 з
[`future/template-functionality-recommendations.md`](./future/template-functionality-recommendations.md).
Пропонований id: `feat-235` (одна фіча, один PR, як `feat-232` і `feat-233`). Рішення Р1–Р14,
задачі T1–T9.

**Редакція 2** (за рев'ю редакції 1):

- Масове відкликання сесій (`logout-all`, `revoke-others`) — це ротація `users.session_token` у
  PostgreSQL, тож подія пишеться в транзакції ротації. Збій вставки залишає попередній токен
  чинним (Р3, Р13). Відкликання однієї сесії (лише Redis) прибрано з першого релізу.
- «До» береться із заблокованого рядка (`SELECT … FOR UPDATE`) у транзакції зміни, «після» — з
  `UPDATE … RETURNING`. Подія скриншота комітиться разом із заміною ключа (Р5).
- IP, маски email і телефону й публічний id сесії з першої версії прибрано. Записуються лише id і
  тип способу входу, тож суперечності між незмінністю (Р2) і очищенням даних немає (Р11).
- Додано подію `auth.account.claimed` для наслідків `claimLocked` і тип виконавця
  `token_holder` для дій, де відомий лише цільовий акаунт (Р4, Р6).
- Payload перевіряється в рантаймі: явна проєкція полів на кожну дію, перевірка ключів і розміру
  JSON у байтах. Обрізання рядків прибрано: межу дають розміри колонок (Р5).
- Задачу строку зберігання прив'язано до контракту планувальника. Уточнено точність `from`/`to` і
  курсора (Р7, Р9).
- Відповіді на відкриті питання: ендпоінт зміни ролі — окрема фіча. Seed пише
  `user.admin.created`. Для промптів — хеш і довжина. Реєстрація, відкликання однієї сесії й масові
  операції бази знань відкладено. Строк зберігання за замовчуванням — 365 днів (підтверджено
  власником), конфігурований.
- Виправлено метод оновлення промпту: `PUT /prompts/:type`.

## Мета

Адміністратор (а через нього підтримка) може відповісти, хто, коли і що змінив у способах входу
користувача, у сесіях (масове відкликання), у статтях бази знань і в AI-промптах. Кожен запис має
виконавця, дію, об'єкт, час, request ID і перевірений у рантаймі набір змін «до/після». Журнал
фільтрується, доступний лише адміністраторам, не містить секретів, IP і контактних даних, а старі
записи видаляються за конфігурованим строком.

Поза межами першого релізу:

- зміна ролі. Ендпоінта немає, він з'явиться окремою фічею разом із подією `user.role.changed`;
- реєстрація, відкликання однієї сесії, `kb.init` і `kb.reindex_all`. Їх додамо, коли з'явиться
  конкретний сценарій розслідування;
- невдалі спроби, журнал читань, перегляд власної історії користувачем, експорт у SIEM;
- IP і контактні дані (Р11).

## Що є зараз (з коду, `main` на `a524ffc`)

- **Загального журналу немає.** Є вузькі журнали: `llm_text_usage` (облік викликів AI, у коді та
  документації його називають «audit», `usage-audit.ts`), `push_notification_logs`, `user_online`.
- **Request ID** генерується на кожен HTTP-запит (`vendor/start/server.ts:501`) і лежить у
  `HttpContext.requestId` та в кожному рядку логу запиту.
- **Права.** Ендпоінта зміни ролі немає. Seed лише **створює** нового адміністратора й ніколи не
  змінює роль наявного користувача (`db/seed/run-seed.ts:87`).
- **Масове відкликання сесій** — ротація `users.session_token` у `withTransaction` разом з
  `retirePendingResets` (ADR 0002): `authService.logoutAll` (`auth-service.ts:1091`) і
  `sessionListService.revokeOthers` (`session-list-service.ts:136`). Очищення записів у Redis іде
  після коміту і не впливає на результат. Відкликання однієї сесії (`revoke`) — лише Redis, без
  ротації.
- **Підтвердження володіння неперевіреним акаунтом.** `claimLocked`
  (`account-claim-service.ts:72`) у транзакції викликача позначає адресу підтвердженою, скидає або
  встановлює пароль, прибирає телефон, **усі OAuth-прив'язки** й push-підписки, гасить токени та
  ротує `session_token`. Його викликають відновлення пароля за посиланням
  (`password-reset-service.ts:381`) і підтвердження OAuth-прив'язки поштою
  (`oauth-service.ts:537`). На підтвердженому акаунті скидання лише змінює пароль і ротує токен.
- **Інші зміни способів входу**: `changePassword`, `confirmPhoneLink` (`auth-service.ts`),
  підтвердження прив'язки email (`email-verification-service.ts`), `handleCallback` з прив'язкою
  (`oauth-service.ts`), `completePhonePasswordReset` (`password-reset-service.ts`),
  `sign-in-methods-service.unlink`.
- **База знань.** `knowledge-base-service.update` читає статтю окремо (`requireArticle`) перед
  `UPDATE` без транзакції (`knowledge-base-service.ts:137`). Заміна скриншота вже транзакційна:
  `replaceScreenshot` блокує рядок `FOR UPDATE` і повертає попередній ключ, а старий об'єкт S3
  видаляється після коміту (`knowledge-base-service.ts:208`, `support-knowledge-repository.ts:165`).
- **AI-промпти.** `prompt-service.update` робить `UPDATE … RETURNING`, відкидає результат і
  перечитує рядок окремим запитом (`prompt-service.ts:73`, `prompt-repository.ts:36`). Маршрут —
  `PUT /prompts/:type` (`shared/src/contracts/prompts.ts:15`). Сторінки у frontend немає.
- **IP**: `get-ip.ts` може повернути рядок `'unknown'` (`vendor/utils/network/get-ip.ts:71`).
- **Планувальник** з контрактом `ctx = { signal, checkpoint, slot, dryRun, logger }` і вимогами до
  задач очищення (`documentation/en/backend/scheduler.md:89`), скіл `scheduled-job`.

## Рішення

### Р1. Сховище — таблиця PostgreSQL `audit_events`, лише додавання

Назва `audit_events`, щоб не плутати з обліком AI, який у документації вже зветься «audit».

| Колонка          | Тип                                 | Призначення                                                    |
| ---------------- | ----------------------------------- | -------------------------------------------------------------- |
| `id`             | `bigserial` PK                      | друга частина ключа порядку                                    |
| `occurred_at`    | `timestamp`, `now()`                | час транзакції зміни; події однієї транзакції мають рівний час |
| `actor_kind`     | enum `user / token_holder / system` | хто виконав (Р6)                                               |
| `actor_user_id`  | `bigint`, **без FK**, NULL          | лише для `user`; без FK, щоб запис пережив видалення акаунта   |
| `actor_role`     | enum ролі, NULL                     | роль виконавця на момент дії, лише для `user`                  |
| `action`         | `varchar(64)`                       | ключ з каталогу Р4                                             |
| `target_type`    | `varchar(32)`                       | `user`, `kb_article`, `llm_prompt`                             |
| `target_id`      | `varchar(64)`                       | id об'єкта як рядок (bigint або тип промпту)                   |
| `target_user_id` | `bigint`, без FK, NULL              | чий акаунт зачеплено                                           |
| `request_id`     | `uuid`, NULL                        | зв'язок із логами; NULL для `system`                           |
| `changes`        | `jsonb`, NULL                       | «до/після» дозволених полів (Р5)                               |
| `metadata`       | `jsonb`, NULL                       | контекст без змін: тип способу входу, провайдер, доказ (Р6)    |

IP, user-agent, email, телефон і публічний id сесії не зберігаються (Р11).

### Р2. Незмінність

Репозиторій має лише `insert`, `list` і `purgeBatch`. Міграція додає тригер
`BEFORE UPDATE … RAISE EXCEPTION`. `DELETE` дозволено лише задачі строку зберігання (Р9). Оскільки
персональних даних, які треба було б очищати, у записі немає (Р11), винятків із тригера не
потрібно. Окремої ролі БД шаблон не має, тож захист від власника БД не обіцяємо, і це зазначено в
документації.

### Р3. Запис у транзакції бізнес-зміни (fail closed)

Усі події першого релізу описують зміни в PostgreSQL. Кожна пишеться `auditService.record(tx, …)`
**у тій самій транзакції**, що й зміна. Збій вставки відкочує зміну, і клієнт отримує `500`.

| Дія                                                                      | Транзакція, в яку пишемо                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `auth.sessions.revoked_all`                                              | `withTransaction` ротації в `logoutAll` (з `retirePendingResets`)              |
| `auth.sessions.revoked_others`                                           | `withTransaction` ротації в `revokeOthers`                                     |
| `auth.password.changed`                                                  | транзакція `changePasswordIfCurrent`                                           |
| `auth.password.reset`, `auth.account.claimed`                            | `runTokenTransaction` відновлення пароля (посилання / SMS)                     |
| `auth.oauth.linked`, `auth.account.claimed`                              | `runTokenTransaction` у `confirmLink`; транзакція прив'язки в `handleCallback` |
| `auth.phone.linked`, `auth.email.linked`, `auth.sign_in_method.unlinked` | наявні транзакції цих методів; де її немає — нова `withTransaction`            |
| `kb.article.*`, `kb.screenshot.*`                                        | нова `withTransaction` (Р5); для скриншота — транзакція `replaceScreenshot`    |
| `ai.prompt.updated`                                                      | нова `withTransaction` (Р5), оновлення кешу — після коміту                     |
| `user.admin.created`                                                     | транзакція вставки користувача в seed                                          |

Подія пишеться лише тоді, коли умовна зміна відбулася (наприклад, `updateIfSessionToken` повернув
рядок). Відмова `session_revoked` або `token_mismatch` події не створює.

Репозиторії, які зараз пишуть напряму в `db` (`promptRepository.update`,
`supportKnowledgeRepository.{create,update,delete}`), отримують параметр `executor: DbExecutor`, як
уже зроблено в `userRepository`.

### Р4. Каталог дій першого релізу — у `shared`, закритий перелік

`shared/src/audit/audit-actions.ts`: `AUDIT_ACTIONS` як `const`-об'єкт і тип `AuditAction`. Для
кожної дії задано тип `changes` і `metadata` та функцію проєкції (Р5).

| Група      | Дія                              | Виконавець (Р6)           | Ціль         | `metadata` / `changes`                                                                        |
| ---------- | -------------------------------- | ------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| Права      | `user.admin.created`             | `system` (`seed`)         | `user`       | `changes: { role: { from: null, to: 'admin' } }`                                              |
| Вхід       | `auth.password.changed`          | `user`                    | `user`       | `{ sessionsRevoked: 'others' }`                                                               |
| Вхід       | `auth.password.reset`            | `token_holder`            | `user`       | `{ proof: 'email_link' \| 'sms_code', claimed }`                                              |
| Вхід       | `auth.account.claimed`           | `token_holder`            | `user`       | `{ via, passwordCleared, phoneRemoved, oauthRemoved: [providers], pushSubscriptionsRemoved }` |
| Вхід       | `auth.phone.linked`              | `user`                    | `user`       | `{ method: 'phone', replaced: boolean }`                                                      |
| Вхід       | `auth.email.linked`              | `token_holder` (Р6)       | `user`       | `{ method: 'email', replaced: boolean }`                                                      |
| Вхід       | `auth.oauth.linked`              | `user` або `token_holder` | `user`       | `{ method: 'oauth', provider, proof }`                                                        |
| Вхід       | `auth.sign_in_method.unlinked`   | `user`                    | `user`       | `{ method, provider? }`                                                                       |
| Сесії      | `auth.sessions.revoked_all`      | `user`                    | `user`       | без полів                                                                                     |
| Сесії      | `auth.sessions.revoked_others`   | `user`                    | `user`       | без полів                                                                                     |
| База знань | `kb.article.created`             | `user`                    | `kb_article` | `changes` з `after`                                                                           |
| База знань | `kb.article.updated`             | `user`                    | `kb_article` | змінені поля (Р5)                                                                             |
| База знань | `kb.article.deleted`             | `user`                    | `kb_article` | `changes` з `before`                                                                          |
| База знань | `kb.screenshot.uploaded/removed` | `user`                    | `kb_article` | `{ screenshot: { from: present, to: present } }`, `mime`                                      |
| AI         | `ai.prompt.updated`              | `user`                    | `llm_prompt` | змінені поля (Р5)                                                                             |

`auth.account.claimed` пишеться окремою подією поряд із подією, яка спричинила підтвердження
(`auth.password.reset` або `auth.oauth.linked`), з тим самим `request_id` і `occurred_at`.
`claimLocked` повертає опис наслідків (`ClaimOutcome.effects`): які OAuth-провайдери й скільки
підписок прибрано, чи був телефон і пароль. Цей опис будується з рядків, які він сам видаляє
(`DELETE … RETURNING provider`), тому не розходиться з фактичною зміною. Подія не пишеться, коли
`claimed: false`.

Відкладено: `user.role.changed` (з першою реальною точкою зміни ролі), `auth.account.created`,
`auth.session.revoked`, `kb.init.started`, `kb.reindex_all.started`.

### Р5. Достовірність і обмеження «до/після»

**Звідки беруться значення.** «До» і «після» читаються в транзакції зміни, а не окремими запитами:

- оновлення статті й промпту: `SELECT … FOR UPDATE` рядка → `UPDATE … RETURNING` → diff →
  `record` → коміт. Паралельна зміна того самого об'єкта чекає блокування, тому `after` першої
  події дорівнює `before` другої;
- створення — `INSERT … RETURNING`, видалення — `DELETE … RETURNING`;
- скриншот: `replaceScreenshot` уже блокує рядок і повертає попередній ключ, подія пишеться в цій
  транзакції. Старий об'єкт S3 видаляється лише після її коміту, як зараз. Ключі S3 у журнал не
  потрапляють, лише факт наявності й `mime`;
- `prompt-service` бере оновлений рядок для кешу з `RETURNING`, а не з повторного читання.

**Що записується.** Список дозволених полів, а не заборонених:

- стаття: `title`, `category`, `isActive` повністю; `content` як
  `{ changed, sha256Before, sha256After, charsBefore, charsAfter }`;
- промпт: `model`, `temperature`, `maxTokens`, `topic` повністю; `content` як у статті (хеш і
  довжина);
- **ніколи**: хеші паролів, токени, OTP, `sessionId`, ключі S3, email, телефон, IP,
  `providerUserId`, `providerEmail`.

Дозволені значення зберігаються **повністю, без обрізання**. Їхню довжину вже обмежує схема:
`title` — 255, `category`, `topic`, `model` — 100 символів.

**Рантайм-перевірка перед INSERT** (`auditPayload.build(action, input)`):

1. Явна проєкція: функція дії будує новий об'єкт, перелічуючи поля, а не розгортаючи вхідний
   (`{ title: row.title }`, а не `{ ...row }`).
2. Перевірка ключів: рекурсивно, кожен ключ `changes` і `metadata` має бути в переліку дії, інакше
   виняток (транзакція відкочується).
3. Розмір: `Buffer.byteLength(JSON.stringify(...)) ≤ 4096` для `changes` і `metadata` разом,
   інакше виняток. Тест будує payload кожної дії з максимальними значеннями колонок
   (багатобайтові символи) і перевіряє, що межа не досягається.
4. Порожній diff (оновлення без змін) не створює події й не робить `UPDATE`.

### Р6. Виконавець: хто підтверджений, а хто лише цільовий акаунт

Тип `AuditActor` передається явним параметром із контролера (`auditActorFrom(context)` у
`controllers/shared`). `AsyncLocalStorage` у проєкті не використовується.

- `user` — запит з автентифікованою сесією (`auth_guard`). `actor_user_id` дорівнює користувачу
  сесії, `actor_role` — роль з того самого читання, що робить `admin_guard` (або з рядка, який
  сервіс уже прочитав).
- `token_holder` — сесії немає або вона не доводить особу, доказом слугує одноразовий секрет:
  посилання з листа, SMS-код, посилання підтвердження OAuth. `actor_user_id = NULL`, відомий лише
  `target_user_id`, а `metadata.proof` називає доказ (`email_link`, `sms_code`,
  `oauth_email_link`). Так пишуться відновлення пароля, `auth.account.claimed`, `confirmLink` і
  підтвердження прив'язки email, навіть якщо посилання відкрили в браузері із сесією: доводить
  дію саме секрет, а не сесія.
- `system` — seed, CLI. `request_id = NULL`, `metadata.source` (`seed`).

### Р7. API читання — `GET /admin/audit-events`

- Окрема група з `session_web, csrf_guard, auth_guard, admin_guard`, як у решти `/admin`.
- Фільтри: `action` (кілька), `group` (`rights / sign-in / sessions / kb / ai`), `actorUserId`,
  `targetUserId`, `targetType` + `targetId`, `requestId`, `from`, `to`.
- **Час**: `from` і `to` — ISO 8601 з точністю до мілісекунди, `occurred_at >= from` і
  `occurred_at < to`. Колонка зберігає мікросекунди, тому межа в мілісекундах означає «включно з
  усією мілісекундою `from`, без усієї мілісекунди `to`».
- **Курсор**: порядок `(occurred_at DESC, id DESC)`, сторінка 50. Курсор несе `occurred_at` як
  рядок, прочитаний у SQL (`occurred_at::text`), і `id`, тож мікросекунди не губляться в JS `Date`.
  Події однієї транзакції мають рівний `occurred_at` (наприклад, `auth.password.reset` і
  `auth.account.claimed`), і саме на них перевіряється курсор (Р13). `COUNT(*)` не рахуємо.
- Відповідь через transformer: `actor` і `targetUser` збагачуються `name` одним запитом по `users`
  для id на сторінці; видалений користувач показується як «видалений #id». Email у відповіді не
  повертаємо.
- Контракт у `shared/src/contracts/admin.ts`, схеми в реєстрі, `response-schema-guards`.

### Р8. Індекси

- `(occurred_at DESC, id DESC)` — стрічка, курсор і строк зберігання;
- `(target_user_id, occurred_at DESC, id DESC)`, `(actor_user_id, occurred_at DESC, id DESC)`;
- `(target_type, target_id, occurred_at DESC, id DESC)`;
- `(action, occurred_at DESC, id DESC)`;
- `(request_id)` частковий, `WHERE request_id IS NOT NULL`.

### Р9. Строк зберігання за контрактом планувальника

Задача `audit-events-retention` (скіл `scheduled-job`, `documentation/en/backend/scheduler.md`):

- конфіг у власному модулі `config/audit-events-retention.ts`: `AUDIT_EVENTS_RETENTION_DAYS`
  (за замовчуванням 365, мінімум 30) і розмір партії, `configError` у `validate-runtime-config.ts`,
  `.env.example`. За помилки конфігу задача відмовляється працювати, без значення за замовчуванням;
- `cutoff` обчислюється **один раз на запуск** і не змінюється між партіями;
- `ctx.checkpoint()` безпосередньо перед кожним SQL-кроком, без `await` між ними;
- партія: `DELETE … WHERE id = ANY(ARRAY(SELECT id FROM audit_events WHERE occurred_at < $cutoff
ORDER BY occurred_at LIMIT $n))`, без читання й наступного запису;
- `dryRun` рахує ті самі рядки й нічого не змінює;
- два одночасні запуски безпечні: кожен рядок видаляється рівно один раз;
- щоденний розклад, `timeout` у межах Р13 планувальника.

Значення за замовчуванням — 365 днів, підтверджене власником. Воно конфігуроване, тож
розгортання з іншою вимогою підтримки задає свій строк.

### Р10. Frontend: `/admin/audit-log`

- Пункт у `AdminLayout`, сторінка `AdminAuditLogView.vue`: таблиця (час, виконавець, дія, об'єкт,
  request ID), фільтри з Р7 у query-рядку URL, кнопка «Показати ще».
- Розгорнутий рядок показує `changes` як таблицю «поле / було / стало», `metadata` і кнопку
  копіювання request ID. Для `token_holder` виконавець показується як «власник посилання / коду
  (доказ)».
- У `AdminUsersView` — посилання «Журнал» на `?targetUserId=…`. У редакторі статті бази знань —
  «Історія змін» на `?targetType=kb_article&targetId=…`.
- Назви дій беруться зі словника frontend за ключами `AUDIT_ACTIONS`.

### Р11. Персональні дані

Перша версія зберігає лише id користувачів, типи способів входу, назви OAuth-провайдерів і
значення адміністративного контенту. IP, user-agent, email, телефон, маски та ідентифікатори в
провайдера не записуються. Для розслідування є `request_id` (зв'язок із логами запиту, де IP уже
є на час їх зберігання) і `target_user_id`.

Тож очищати в записі після видалення акаунта нічого, і незмінність (Р2) не має винятків. Якщо IP
знадобиться для конкретного сценарію підтримки, це буде окреме рішення: хто й як очищає поле, як
`'unknown'` з `get-ip.ts` перетворюється на `NULL`, і як очищення узгоджується з тригером.

### Р12. Дубль у структурований лог

Після коміту `auditService` пише `logger.info({ audit: { action, targetType, targetId } })` у логер
запиту, тож подію знайдено й за request ID у логах. `changes` у лог не потрапляють.

### Р13. Тести

**Unit**

- `auditPayload.build` для кожної дії каталогу: вхід із зайвими полями (`password`, `sessionToken`,
  `providerEmail`, `screenshotKey`) не потрапляє в серіалізований JSON. Невідомий ключ дає
  виняток. Максимальні значення колонок у багатобайтових символах вкладаються в 4096 байт.
- `diffAllowed` і порожній diff.
- Контролери будують `AuditActor` правильного типу для `user`, `token_holder` і `system`.

**PG (`*.pg.test.ts`)**

- Атомарність: збій вставки події (підмінений `record`, що кидає) відкочує зміну промпту, статті,
  скриншота, пароля, відв'язки. Для `logout-all` і `revoke-others` **попередній `session_token`
  лишається чинним**, а посилання скидання не погашені.
- Гонки: дві одночасні зміни одного промпту і однієї статті (`race-barrier.ts`) дають `after`
  першої події, рівний `before` другої.
- Claim: скидання паролем неперевіреного акаунта з телефоном і двома OAuth-прив'язками пише
  `auth.password.reset` і `auth.account.claimed` з обома провайдерами, з одним `request_id` і
  `occurred_at`. На підтвердженому акаунті `claimed` не пишеться.
- Тригер забороняє `UPDATE`.
- Курсор: кілька подій з рівним `occurred_at` (одна транзакція) і межі `from`/`to` на
  мікросекундних значеннях. Сторінки не губляться й не повторюються.
- Строк зберігання за вимогами планувальника: рядки на кілька хвилин по обидва боки `cutoff`,
  малий розмір партії, `checkpoint`, що кидає після першої партії, `dryRun`, два перекриті запуски,
  `EXPLAIN` партії знаходить індекс без сортування.

**HTTP**: `GET /admin/audit-events` дає `401`/`403` для не-адміна. Перевіряються фільтри,
валідація курсора й `from`/`to`.

**`layering.spec.ts`**: репозиторій `audit-events` має лише `insert / list / purgeBatch`.

**e2e**

- `test:e2e` (мокований API): сторінка журналу, фільтри, розгортання рядка, «Показати ще».
- `test:e2e:live` (справжній backend): адмін змінює статтю в UI бази знань і промпт через
  `PUT /prompts/:type` API (сторінки промптів немає), потім бачить обидві події в `/admin/audit-log`
  зі своїм ім'ям. Користувач змінює пароль і натискає «Вийти всюди», після чого адмін знаходить ці
  події за `targetUserId`.
- Відкат при збої запису доводять PG-тести, не e2e.

**Мутації**: прибрати `record` з будь-якої точки запису — падає тест цієї точки. Замінити `FOR
UPDATE` на звичайне читання — падає тест гонки.

### Р14. Документація

Нова сторінка `documentation/backend/audit-log.md` і `documentation/en/backend/audit-log.md`:
модель, каталог дій, типи виконавців, політика полів, гарантія fail closed, API, точність часу,
строк зберігання, межі захисту від власника БД. Сайдбари обох локалей, `KEY_PAGES` і
`EN_KEY_PAGES`. Задача — у таблиці задач і змінних `scheduler.md`, змінна — у `configuration.md`.
Сторінки auth, сесій, AI і бази знань посилаються на журнал. Також нова міграція.

## Задачі

| #   | Задача                                                                                                                                                   | Залежить |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| T1  | `shared`: `AUDIT_ACTIONS`, типи `changes`/`metadata`, проєкції, перевірка ключів і байтового розміру, `diffAllowed`, схеми контракту + unit              | —        |
| T2  | Схема `audit_events`, enum-и, індекси Р8, тригер Р2, міграція (folder-per-migration), relations                                                          | —        |
| T3  | Репозиторій `audit-events` (`insert/list/purgeBatch`, курсор Р7), `auditService.record`, `AuditActor`, `auditActorFrom`, лог Р12                         | T1, T2   |
| T4  | Промпти й база знань: `executor`, `FOR UPDATE` + `RETURNING`, подія скриншота в `replaceScreenshot`, кеш промпту з `RETURNING`, PG-тести гонок і відкату | T3       |
| T5  | Способи входу й сесії: `ClaimOutcome.effects`, події в транзакціях Р3, `token_holder`, seed `user.admin.created`, PG-тести відкату й claim               | T3       |
| T6  | `GET /admin/audit-events`: контракт, контролер, transformer, маршрут, HTTP-тести, тести курсора                                                          | T3       |
| T7  | Задача `audit-events-retention` за контрактом планувальника, конфіг-модуль, `.env.example`, PG-тести Р9                                                  | T3       |
| T8  | Frontend: `AdminAuditLogView`, пункт меню, посилання з користувачів і статей, `test:e2e` і `test:e2e:live`                                               | T6       |
| T9  | Документація обох локалей (Р14), `docs:build && docs:verify`, evidence                                                                                   | T4–T8    |

Definition of Done: `make check`; `make test-pg` і `make test-redis` з кількістю виконаних і
пропущених тестів; `pnpm --filter frontend test:e2e` і `test:e2e:live`;
`pnpm docs:build && pnpm docs:verify`; `job:run audit-events-retention --dry-run`, а потім без
нього на сидованих рядках (лічильники збігаються). Ручний прохід: змінити статтю, промпт (через
API), пароль, відв'язати спосіб входу, «Вийти всюди», а потім знайти кожну подію в
`/admin/audit-log` за фільтрами й за request ID у логах.

## Ризики

- **Ширина зміни auth.** `actor` і запис події проходять через методи з налагодженими гонками
  (feat-096/097/099/100/233). `record` лише додається всередину наявних транзакцій, умови не
  змінюються. Наявні `*.pg.test.ts` гонок мають лишитися зеленими без правок.
- **`claimLocked` повертає наслідки.** Заміна `deleteByUserId` на `DELETE … RETURNING provider`
  змінює сигнатуру репозиторію. Покривається тестами `oauth-pre-hijack.pg.test.ts` і новим тестом
  claim.
- **Fail closed** робить зміни промптів, статей і способів входу залежними від вставки в журнал.
  Це свідомо: та сама БД, той самий коміт.
- **Блокування `FOR UPDATE`** на статтях і промптах серіалізує їх паралельні зміни. Обсяг — одиниці
  на хвилину, адміністративні дії.
