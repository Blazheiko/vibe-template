# Журнал дій

Адміністратор (а через нього підтримка) може відповісти, хто, коли і що змінив у способах входу акаунта, у його сесіях (масове відкликання), у базі знань і в AI-промптах. Кожен запис має виконавця, дію, об'єкт, час, request ID і перевірений у рантаймі набір значень «до/після». Журнал фільтрується, доступний ролям із дозволом `audit.read.account` (повністю — з `audit.read`, див. [Ролі та можливості](/reference/roles-capabilities)), не містить секретів, IP-адрес і контактних даних, а старі записи видаляються за конфігурованим строком (feat-235).

Джерела: каталог [`shared/src/audit/audit-actions.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/audit/audit-actions.ts), сервіс [`audit-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/audit/audit-service.ts), репозиторій [`audit-events-repository.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/repositories/audit/audit-events-repository.ts), сторінка [`AdminAuditLogView.vue`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/views/admin/AdminAuditLogView.vue).

## Таблиця `audit_events`

| Колонка          | Тип                                 | Призначення                                                      |
| ---------------- | ----------------------------------- | ---------------------------------------------------------------- |
| `id`             | `bigserial`                         | друга частина ключа порядку                                      |
| `occurred_at`    | `timestamp(6)`, без default         | момент зміни після блокування її рядка; спільний для подій зміни |
| `actor_kind`     | enum `user / proof_holder / system` | хто виконав                                                      |
| `actor_user_id`  | `bigint`, без FK                    | лише для `user`; запис переживає акаунт                          |
| `actor_role`     | `user_role`                         | роль виконавця на момент дії, лише для `user`                    |
| `action`         | `varchar(64)`                       | ключ каталогу нижче                                              |
| `target_type`    | `varchar(32)`                       | `user`, `kb_article`, `llm_prompt`                               |
| `target_id`      | `varchar(64)`                       | id об'єкта як текст (id рядка або тип промпту)                   |
| `target_user_id` | `bigint`, без FK                    | чий акаунт зачеплено                                             |
| `request_id`     | `uuid`                              | зв'язок із логами запиту; `NULL` для `system`                    |
| `changes`        | `jsonb`                             | `{ from, to }` дозволених полів                                  |
| `metadata`       | `jsonb`                             | контекст: спосіб входу, провайдер, доказ, джерело                |

Індекси: `(occurred_at, id)` для стрічки, курсора й задачі строку зберігання; той самий хвіст після `target_user_id`, `actor_user_id`, `(target_type, target_id)` і `action`; частковий індекс `request_id`. Міграція [`20261120113018_audit_events`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/drizzle/migrations/20261120113018_audit_events/migration.sql) також додає тригер `audit_events_no_update`: `UPDATE` рядка падає. `DELETE` дозволено задачі строку зберігання. Тригер захищає від застосунку, а не від власника БД, який може його прибрати; окремої ролі БД шаблон не має.

## Каталог дій

| Група    | Дія                                  | Виконавець               | Об'єкт       | Вміст                                                                                            |
| -------- | ------------------------------------ | ------------------------ | ------------ | ------------------------------------------------------------------------------------------------ |
| rights   | `user.admin.created`                 | `system` (`seed`)        | `user`       | `changes.role: { from: null, to: 'admin' }`                                                      |
| rights   | `user.role.changed`                  | `user`, `system` (`cli`) | `user`       | `changes.role: { from, to }`; для `system` — `metadata.source`                                   |
| sign-in  | `auth.password.changed`              | `user`                   | `user`       | `{ sessionsRevoked: 'others' }`                                                                  |
| sign-in  | `auth.password.reset`                | `proof_holder`           | `user`       | `{ proof: 'email_link' \| 'sms_code', claimed }`                                                 |
| sign-in  | `auth.account.claimed`               | `proof_holder`           | `user`       | `{ proof, passwordCleared, phoneRemoved, oauthRemoved: [провайдери], pushSubscriptionsRemoved }` |
| sign-in  | `auth.phone.linked`                  | `user`                   | `user`       | `{ method: 'phone', proof: 'sms_code' }`                                                         |
| sign-in  | `auth.email.linked`                  | `user`                   | `user`       | `{ method: 'email', proof: 'email_link' }`                                                       |
| sign-in  | `auth.oauth.linked`                  | `proof_holder`           | `user`       | `{ method: 'oauth', provider, proof: 'oauth_email_link' \| 'oauth_provider_email' }`             |
| sign-in  | `auth.sign_in_method.unlinked`       | `user`                   | `user`       | `{ method, provider }`                                                                           |
| sessions | `auth.sessions.revoked_all`          | `user`                   | `user`       | без полів                                                                                        |
| sessions | `auth.sessions.revoked_others`       | `user`                   | `user`       | без полів                                                                                        |
| kb       | `kb.article.created/updated/deleted` | `user`                   | `kb_article` | `title`, `category`, `isActive`; текст як відбиток                                               |
| kb       | `kb.screenshot.uploaded/removed`     | `user`                   | `kb_article` | `{ screenshot: { from, to } }` (лише наявність), `mime`                                          |
| ai       | `ai.prompt.updated`                  | `user`                   | `llm_prompt` | `model`, `temperature`, `maxTokens`, `topic`; текст як відбиток                                  |

`auth.account.claimed` пишеться поряд із подією, що спричинила підтвердження (скидання за посиланням, прив'язка OAuth), з тим самим `request_id` і `occurred_at`. `user.role.changed` пише сервіс [`role-assignment-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/role-assignment-service.ts) у транзакції зміни ролі; зараз її викликає лише CLI `user:set-role` (виконавець `system`, джерело `cli`, див. [Скрипти](/reference/scripts)). Поки не записуються: реєстрація, відкликання однієї сесії, невдалі спроби.

## Виконавці й докази

- `user` — запит з автентифікованою сесією; `actor_user_id` — користувач сесії. Дія, що додатково вимагає одноразового доказу, записує його в `metadata.proof` (посилання з листа, відкрите з сесії акаунта, SMS-код челенджу, прив'язаного до сесії).
- `proof_holder` — сесії акаунта немає, лише доказ. `actor_user_id` — `NULL`, доказ обов'язковий: `email_link` (відновлення пароля за посиланням), `sms_code` (відновлення через SMS), `oauth_email_link` (прив'язка OAuth, підтверджена листом у браузері входу), `oauth_provider_email` (провайдер підтвердив адресу).
- `system` — seed або CLI; `request_id` — `NULL`, `metadata.source` називає джерело: `seed` або `cli` (`AUDIT_SYSTEM_SOURCES`).

::: warning План
Зміна ролі виконавцем `user` (адміністратор через HTTP) — feat-241: ендпоінта ще немає, каталог і сервіс її вже приймають.
:::

Каталог також перелічує докази, які приймає кожна дія, і `record` відхиляє будь-які інші: `proof_holder` потребує одного з них, `auth.phone.linked` — `sms_code`, `auth.email.linked` — `email_link`, а дія без доказів доказ відхиляє. Виконавець `user` або `proof_holder` завжди несе request ID: сервіси приймають виконавця (або запит) обов'язковим параметром.

## Що записується

Кожна дія перелічує поля, які зберігає; проєкція ніколи не копіює рядок. Тексти статті й промпту записуються як `{ changed, sha256Before, sha256After, charsBefore, charsAfter }`. **Ніколи** не записуються: хеші паролів, токени, коди, id сесій, ключі S3, email, телефони, IP-адреси, ідентифікатори й адреси в провайдера. Перед вставкою payload проходить перевірку ключів (кожен ключ на будь-якій глибині має бути в каталозі дії) і розміру: серіалізовані `{ changes, metadata }` — щонайбільше **8192 байти**. Межу виведено з найгіршого випадку: керівний символ займає в JSON 6 байтів (`\u0001`), тож оновлення статті з найдовшими назвою й категорією займає близько 4,6 КБ. Тест будує найгірший випадок кожної дії.

Редагування без змін (ті самі значення, що в рядку) не робить `UPDATE` і не пише події: `updatedAt`, версія тексту й embedding статті лишаються.

## Fail closed і час події

Кожна подія пишеться в транзакції зміни, яку описує. Якщо вставка не вдалася, зміна відкочується, клієнт отримує `500`: після невдалого logout-all попередній токен сесії чинний, після невдалого скидання посилання з листа лишається придатним, SMS-код прив'язки телефону лишається непідтвердженим. Прив'язка телефону підтверджує код у тій самій транзакції під блокуванням рядка користувача і під ним знову перевіряє сесію та відсутність номера.

`occurred_at` — це `clock_timestamp()`, прочитаний після інструкції, що блокує змінений рядок, а не `now()` (початок транзакції). Тож історія одного об'єкта показує зміни в порядку їх застосування. Між різними об'єктами це лише годинник сервера БД.

Після коміту кожна подія пишеться в лог на рівні `info` як `audit event` з `action`, `targetType` і `targetId` (без `changes`). Для HTTP це логер запиту, тож подію видно в логах і за request ID.

## API

`GET /api/admin/audit-events` (`session_web`, `csrf_guard`, `auth_guard`, `can:audit.read.account`), контракт `adminContracts.auditEvents`.

Обсяг залежить від ролі ([`audit-events-query-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/admin/audit-events-query-service.ts)): з дозволом `audit.read` (`user_admin`, `admin`) видно весь журнал. Без нього (`support_operator`) видно лише дії груп `sign-in` і `sessions` з `targetType = user`; запит звужується до курсора й ліміту, тож сторінка не містить чужих рядків. Явний фільтр поза цим обсягом (`group`, будь-яка з `action`, `targetType`) — `403 forbidden` `Access denied`.

| Параметр                 | Значення                                                                   |
| ------------------------ | -------------------------------------------------------------------------- |
| `action`                 | повторюваний: `?action=a&action=b`                                         |
| `group`                  | `rights`, `sign-in`, `sessions`, `kb`, `ai`; разом з `action` діють обидва |
| `actorUserId`            | виконавець                                                                 |
| `targetUserId`           | акаунт, якого стосується зміна                                             |
| `targetType`, `targetId` | об'єкт                                                                     |
| `requestId`              | один запит                                                                 |
| `from`, `to`             | ISO 8601; `occurred_at >= from`, `occurred_at < to`                        |
| `cursor`                 | `nextCursor` попередньої сторінки                                          |

Сторінки по 50, новіші першими за `(occurred_at, id)`; загальна кількість не рахується. Курсор несе `occurred_at` у вигляді, який друкує PostgreSQL, тож мікросекунди не губляться в JS `Date`; невалідний курсор — `400`, як і id користувача поза діапазоном `bigint` PostgreSQL та курсор з неіснуючою датою (запит неправильної форми — `422`). `from` і `to` мають точність до мілісекунди: `from` включає всю свою мілісекунду, `to` — виключає свою. Виконавець і акаунт отримують імена одним запитом до `users`; видалений акаунт приходить як `deleted: true` з id. Email не повертається.

## Строк зберігання

Задача планувальника `audit-events-retention` (щодня о 04:00 UTC) видаляє події, старші за `AUDIT_EVENTS_RETENTION_DAYS` (за замовчуванням 365, щонайменше 30), пачками по `AUDIT_EVENTS_PURGE_BATCH_SIZE` (за замовчуванням 1000). Межа обчислюється один раз за запуск; два одночасні запуски видаляють кожен рядок один раз. Див. [Фонові задачі](/backend/scheduler).

```bash
pnpm --filter backend job:run audit-events-retention --dry-run
```

## Сторінка адміністратора

`/admin/audit-log` (дозвіл `audit.read.account`): таблиця (час, виконавець, дія, об'єкт, request ID), фільтри в адресі сторінки (кілька дій одразу), «Показати ще». Без `audit.read` фільтри пропонують лише групи `sign-in`, `sessions` і тип об'єкта `user`. Відповідь на сторінку, запитану до зміни фільтрів, відкидається. Рядок розгортає зміни як «поле / було / стало» і кнопку копіювання request ID; `proof_holder` показано як «без входу» з назвою доказу. Зі списку користувачів веде посилання на журнал акаунта, з бази знань — на історію статті (лише з `audit.read`).
