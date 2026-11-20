# Центр сповіщень — покроковий task list

**Редакція 2** (2026-11-20, за рев'ю редакції 1):

- Збій читання налаштувань пропускає push, а відсутній рядок дає значення за замовчуванням.
  Підставляти `true` при збої не можна: це порушує збережене `support.push: false` (T4.2).
- Тест чужого `read` перевіряє, що чужий рядок лишився непрочитаним, а не лише `404`. Без цього
  мутація з `user_id` тільки в `SELECT` проходила б (T3, T5, T10).
- Правила параметрів API: `limit` за замовчуванням 20, межа PostgreSQL `bigint` для `:id`,
  `before` і `upTo` до SQL-запиту, HTTP-тест на `9223372036854775808` (T1, T5).
- Життєвий цикл відкритого списку: парні `openList()` / `closeList()` для панелі дзвоника (усі
  способи закриття) і для сторінки історії (T7).
- T0 розділено: спершу PR з реєстрацією `feat-236` як `not-started` після перевірки
  канонічного реєстру, потім окремий PR переходу в `in_progress` (T0a, T0b; `AGENTS.md`, крок 2).

Джерело: [`notification-center-plan.md`](./notification-center-plan.md) (редакція 3.1, рішення
Р1–Р13). Фіча `feat-236`, гілка `feat/notification-center`. Базовий шлях: `packages/`, якщо не
вказано інше. Коміт для посилань: `1fbb8d4`.

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
`test:e2e:live`; `pnpm docs:build && pnpm docs:verify`; `job:run notifications-retention` з
`--dry-run` і без нього; ручний прохід golden path (T10). Усе це в
`feature-state/feat-236/progress.md` → Evidence of Completion.

**Інваріанти для всіх задач:**

1. `notify` синхронно повертає `void` і ніколи не кидає. Код після нього, зокрема security-лист,
   виконується за будь-якого результату (Р5).
2. Security-листи не змінюються: ті самі умови, адресати, тексти й тести. Єдиний свідомий виняток —
   поле `provider` у `SignInMethodAdded` і фікстура його тесту (T4.3).
3. WS-події — лише сигнали з порожнім payload. Лічильник приходить тільки з HTTP (Р8).
4. Кожен новий маршрут має `auth_guard`, група — `session_web` + `csrf_guard` явно (Р4, Р6).
5. Чинні тести `resolveNotificationTarget` (`notification-target.spec.ts`) не змінюються (Р7).

## Порядок

T0a → T0b → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10.

| Задача | Залежить від |
| ------ | ------------ |
| T0b    | T0a          |
| T1     | T0b          |
| T2     | T1           |
| T3     | T2           |
| T4, T6 | T3           |
| T5     | T4           |
| T7     | T5           |
| T8     | T7           |
| T9     | T5–T8        |
| T10    | усі          |

T6 (строк зберігання) не залежить від T4 і T5 і може йти паралельно з ними.

---

### T0a · Реєстрація фічі

Нова фіча спершу реєструється окремим PR, і лише потім береться в роботу (`AGENTS.md`, крок 2).

- [ ] `git fetch`, потім `git show origin/main:feature_list.json`: id `feat-236` вільний, і жоден
      запис не описує центр сповіщень. На коміті `1fbb8d4` останній id — `feat-235`. Якщо id
      зайнятий, взяти наступний вільний і замінити його в плані й цьому списку.
- [ ] PR до `main` (гілка `chore/feat-236-plan`): план, цей task list і запис `feat-236` зі
      статусом `not-started`, `owner`, `branch: feat/notification-center`, `dependencies: []`,
      опис з посиланням на план. Змерджити після зелених перевірок.

### T0b · Старт фічі

- [ ] Знову `git fetch` і читання реєстру з `origin/main`: `feat-236` є, статус `not-started`,
      `owner` — ти, `dependencies` порожні (або всі `done`).
- [ ] Короткий PR до `main` (гілка `chore/feat-236-start`): `feat-236` → `in_progress` у
      `feature_list.json`.
- [ ] Гілка `feat/notification-center` від `main`, `feature-state/feat-236/progress.md` (стан,
      наступний крок) і порожній `session-handoff.md`.
- [ ] `./init.sh` зелений, результат у `progress.md`. Якщо червоний — зупинитися й зафіксувати
      команду та вивід.

### T1 · Каталог і контракти (`shared`) — Р2, Р3, Р4, Р7, Р8, Р9

- [ ] `shared/src/notifications/categories.ts`: `NOTIFICATION_CATEGORIES = ['security', 'support']`,
      `NOTIFICATION_CHANNELS = ['push', 'email']`, типи `NotificationCategory`,
      `NotificationChannel`.
- [ ] `shared/src/notifications/kinds.ts`: `NOTIFICATION_KINDS` — 9 видів таблиці Р2. Для кожного:
      `category`, схема `params` (arktype), `link(params)`. Типи `NotificationKind`,
      `NotificationParams<K>`.
    - `security.new_sign_in` → `{ device: string }`, `/account#sessions`;
    - `security.method_added`, `security.method_removed` → `{ provider }` за
      `OAuthProviderSchema` (`shared/src/responses/oauth-controller.ts`: `google`, `facebook`,
      `github`, `gitlab`), `/account`;
    - `security.session_revoked` → `{ device?: string }`, `/account#sessions`;
    - `security.password_changed`, `password_reset`, `logout_all`, `account_claimed` → `{}`,
      `/account`;
    - `support.reply` → `{}`, `/support`.
- [ ] Межі `params` (Р9): лише оголошені ключі (зайвий ключ — помилка), рядки ≤ 128 символів,
      `NOTIFICATION_PARAMS_MAX_BYTES = 1024`. Перевірку байтів робить backend (`Buffer.byteLength`,
      T4.1); у `shared` — константа й перевірка ключів.
- [ ] `shared/src/notifications/channel-policy.ts` (Р4): для кожної пари категорія × канал —
      `available`, `locked`, `default`. `security.push` — доступний, не заблокований, `true`;
      `security.email` — доступний, заблокований, `true`; `support.push` — доступний, `true`;
      `support.email` — недоступний. Функція `resolvePreferences(rows)` → повна матриця
      `{ category, channel, enabled, locked }[]` (рядок БД перекриває `default`; для `locked`
      завжди `default`).
- [ ] `shared/src/utils/notification-link.ts`: `isNotificationLink(value)` (Р7) — один `/` на
      початку, не `//`, не `/\`, без схеми й хоста, query і хеш дозволено. Експорт через
      `shared/src/utils/index.ts`.
- [ ] Схеми відповідей і запитів (`shared/src/schemas/notifications/`, `shared/src/responses/`):
      `NotificationItemSchema` (`id: string`, `kind`, `category`, `params`,
      `link: string | null`, `createdAt`, `readAt: string | null`), `NotificationsPageSchema`
      (`items`, `next: string | null`, `unreadCount`), `UnreadCountSchema`,
      `MarkReadResponseSchema` (`link`, `unreadCount`), `ReadAllBodySchema` (`upTo`),
      `NotificationPreferencesSchema`, `UpdateNotificationPreferenceSchema` (`category`,
      `channel`, `enabled`), query-схема списку (`unread?`, `before?`, `limit?`).
- [ ] Правила параметрів API (Р6), спільні для схем і контролера:
    - `limit` — ціле 1–50, без параметра — `NOTIFICATIONS_PAGE_DEFAULT = 20`;
    - `:id`, `before`, `upTo` — рядок `^[1-9][0-9]{0,18}$`, значення не більше
      `9223372036854775807` (межа PostgreSQL `bigint`). Перевірка `isPgBigintId(value)` у
      `shared/src/utils`: довжина, регулярний вираз і порівняння через `BigInt`, до будь-якого
      SQL-запиту. `Number` не використовується: він втрачає точність після `2^53`;
    - `unread` — лише `1` або відсутній.
- [ ] WS (`shared/src/schemas/ws/broadcast-events.ts`): `notifications_changed: type({})`,
      `notification_preferences_changed: type({})`.
- [ ] Експорт модуля `shared/notifications` у `package.json` `exports` (з умовою `shared-source`,
      як `shared/audit`) і `shared/test/exports.test.js`.
- [ ] Тести `shared/test/notifications.test.js`:
    - кожен вид має категорію з переліку, схему й `link`, що проходить `isNotificationLink`;
    - зайвий ключ, задовгий рядок, невідомий `provider` — помилка;
    - `resolvePreferences`: без рядків — значення за замовчуванням; рядок `security.email:false`
      ігнорується (`locked`); `support.email` у матриці відсутній;
    - `isPgBigintId`: приймає `1`, `9223372036854775807`; відкидає `0`, `01`, `-1`, `1.5`, `1e3`,
      `9223372036854775808`, рядок із 20 цифр, `''`;
    - query-схема без `limit` дає 20; `0` і `51` — помилка;
    - `isNotificationLink` приймає `/account#sessions`, `/support?tab=chat`; відкидає `//host`,
      `/\host`, `https://app/x`, `account`, `javascript:alert(1)`, `''`.

### T2 · Таблиці й міграція — Р1, Р4

- [ ] `backend/src/database/schema.ts`:
    - `notifications` (Р1): колонки, FK `user_id` з `onDelete: 'cascade'`, `CHECK` для `category`
      і `kind` через `sqlStringList(NOTIFICATION_CATEGORIES)` /
      `sqlStringList(Object.keys(NOTIFICATION_KINDS))`, `CHECK` `link` (`link IS NULL OR link LIKE
'/%'`);
    - індекси: `notifications_user_id_id_idx (user_id, id DESC)`, частковий
      `notifications_user_unread_idx (user_id, id DESC) WHERE read_at IS NULL`,
      `notifications_created_at_idx (created_at)`;
    - `notification_preferences` (Р4): PK `(user_id, category, channel)`, FK `cascade`, `CHECK`
      `category` і `channel`;
    - з `push_subscriptions` прибрати `notificationTypes`.
- [ ] `backend/src/database/relations.ts`: `users` → `notifications`, `notificationPreferences`.
- [ ] Міграція у форматі folder-per-migration (`pnpm --filter backend db:generate`, drizzle-kit
      `1.0.0-rc.5`), назва `*_notification_center`. Перевірити SQL: `DROP COLUMN notification_types`,
      частковий індекс, обидва `CHECK`.
- [ ] Прибрати `notificationTypes` зі всіх місць, що компілюються проти схеми:
      `repositories/notifications/push-subscription-repository.ts`,
      `services/notifications/push-subscription-service.ts`, `push-notification-sender-service.ts`
      (`acceptsType` і параметр `notificationType` — тимчасово ігнор до T4.2),
      `shared/src/schemas/push-subscription/*`, `shared/src/responses/push-subscription-controller.ts`,
      `transformers/push-subscription-transformer.ts`, `scripts/bench-response-check.ts`,
      `frontend/src/stores/push.ts:207`. Тести, що перевіряли поле, оновити.
- [ ] `pnpm typecheck`, `pnpm --filter backend test`; міграція застосовується на чистій БД
      (`make test-pg` проганяє її).

### T3 · Репозиторії — Р1, Р4, Р6, Р10

- [ ] `backend/src/app/repositories/notifications/notification-repository.ts`:
    - `insert({ userId, category, kind, params, link })` → `{ id }`;
    - `page(userId, { unread, before, limit })` → рядки `id DESC`, `id < before`; `next` — id
      останнього, якщо повернуто `limit` рядків;
    - `countUnread(userId)` — `COUNT(*)` над підзапитом з `LIMIT 100` (SQL з Р6);
    - `markRead(userId, id)` → `{ link } | null`: спершу
      `UPDATE … SET read_at = now() WHERE id = $id AND user_id = $user AND read_at IS NULL`,
      потім `SELECT link … WHERE id = $id AND user_id = $user`. Обидва запити обмежені
      `user_id`. `null` — рядка немає або він чужий;
    - `markAllUpTo(userId, upTo)` — `UPDATE … WHERE user_id AND id <= upTo AND read_at IS NULL`;
    - `purgeBatch(before, limit)` і `countPurgeable(before)` — за шаблоном Р10.
- [ ] `backend/src/app/repositories/notifications/notification-preference-repository.ts`:
      `findByUserId(userId)` і `upsert(userId, category, channel, enabled)`
      (`ON CONFLICT … DO UPDATE`, `updated_at = now()`).
- [ ] Експорт через `repositories/index.ts`, типи `NotificationRow`, `NotificationInsert`.
- [ ] PG (`repositories/notifications/notifications.pg.test.ts`):
    - вставка й сторінки: 25 рядків, `limit 10` → три сторінки без пропусків і повторів; `unread`
      фільтрує;
    - `countUnread` дає 100 при 150 непрочитаних;
    - `markRead`: свій → `{ link }`, повтор → той самий `{ link }`, `read_at` не змінюється
      (порівняти значення); відсутній → `null`; рядок з `link: null` → `{ link: null }`;
    - `markRead` чужого: відповідь `null`, і **рядок іншого користувача лишається непрочитаним**
      (`read_at IS NULL` після запиту). Без цієї перевірки мутація «прибрати `user_id` з
      `UPDATE`» пройшла б: `SELECT` усе одно дав би `null`;
    - `markAllUpTo` позначає всі `id <= upTo`, зокрема старші за першу сторінку, і не чіпає
      `id > upTo`;
    - `upsert` двічі — один рядок, останнє значення;
    - `CHECK`: невідомий `kind`, `category`, `channel`, `link` без `/` — помилка вставки;
    - видалення користувача видаляє його сповіщення й налаштування.

### T4 · `notificationService.notify` і місця виклику — Р3, Р5, Р9

#### T4.1 · Сервіс

- [ ] `backend/src/app/services/notifications/notification-service.ts`:
      `notify<K>(userId, kind: K, params: NotificationParams<K>): void`. Усередині
      `void run().catch(log)`, і кожен крок має свій `try/catch` з логом (`kind`, `userId`, без
      `params`):
    1. перевірка `params` схемою виду і ключів, розмір
       `Buffer.byteLength(JSON.stringify(params))` не більше 1024 байтів;
       `link = kind.link(params)` і перевірка `isNotificationLink`. Помилка — лог `error` і вихід;
    2. `notificationRepository.insert` → `id | null` (помилка — лог `warn`, `null`);
    3. якщо `id` є — `userEventBus.publishToUser(userId, 'notifications_changed', {})`;
    4. push (T4.2).
- [ ] `backend/src/app/services/notifications/notification-push-texts.ts`: англійські `title`,
      `body`, `tag` за видом (перенос `SECURITY_MESSAGES` і тексту `supportReply`).
      `new_sign_in` і `session_revoked` підставляють `device`, якщо він є (Р3).
- [ ] Unit (`notification-service.spec.ts`), за порядком кроків Р5:
    - збій перевірки `params` (зайвий ключ, > 1024 байти, `link` не проходить) — ні вставки, ні
      сигналу, ні push; `notify` не кидає;
    - збій вставки — сигналу немає, push іде з `url = link` виду і без `notificationId`;
    - збій шини — push іде; збій push — вставка й сигнал уже відбулися;
    - успіх — push з `data.notificationId = id` і `url = /notifications/<id>/open`.

#### T4.2 · Push за категорією

- [ ] `pushNotificationSenderService.sendToUser`: замість `notificationType` — `category`. Перед
      вибіркою підписок — `notificationPreferenceRepository.findByUserId` і
      `resolvePreferences`; якщо `push` категорії вимкнено — `{ sent: 0, failed: 0 }` без запитів.
      `acceptsType` видалити.
- [ ] Відсутній рядок і помилка читання — різні випадки (Р4):
    - рядка для пари категорія × `push` немає — діє `default` з каталогу;
    - читання налаштувань упало (БД недоступна, таймаут) — push **пропускається** для всіх
      пристроїв, лог `warn` з `category` і `userId`. Підставити `default: true` не можна: якщо
      збережено `support.push: false`, це порушило б гарантію «вимкнений push не надходить на
      жоден пристрій». Втрата push тут — той самий best effort, що й інші збої (Р5); сповіщення
      лишається в історії, якщо вставка вдалась.
- [ ] `skipIfOnline` лишається тільки для `support.reply` (присутність на своєму інстансі, як
      зараз).
- [ ] Тестовий push (`push-subscription-controller.ts:216`) налаштувань категорій не читає й
      нічого не зберігає (без змін поведінки).
- [ ] Unit (`push-notification-sender-service.spec.ts`): вимкнений `push` категорії — жодного
      `sendPush`; увімкнений — як раніше; рядка немає — діє `default` (push іде); **збій читання
      налаштувань — жодного `sendPush`** і лог `warn`, також коли збережено
      `support.push: false`. `support.reply` з контрольованою присутністю (мок
      `wsConnectionRegistry.isUserOnline`): онлайн — push немає, офлайн — є.

#### T4.3 · Місця виклику

- [ ] `user-notification-service.ts`: `security(userId, kind, params)` і `supportReply(userId)`
      — тонкі обгортки над `notify`. Тип `SecurityEvent` замінити на `security.*` види каталогу.
- [ ] Підстановка `params`:
    - `new-sign-in-notice.ts` `notifyNewSignIn` → `{ device: deviceLabel(device.userAgent) }`;
    - `oauth-service.ts` `announceLink` → `method_added` з `{ provider }` або
      `account_claimed`;
    - `sign-in-method-notice.ts`: `SignInMethodAdded` отримує `provider`; `providerTitle`
      обчислюється з нього в `renderSignInMethodAddedEmail` (або на виклику `sendMail`);
      `announceLink` передає `provider` замість `providerTitle(provider)`;
    - `sign-in-methods-service.ts:190` → `method_removed` з `{ provider: removed.value.provider }`;
    - `password-reset-service.ts:453` (`account_claimed` / `password_reset`) і `:594`
      (`password_reset`) — `{}`; `announcePasswordReset` лишається після `notify` в обох гілках;
    - `auth-service.ts:1208`, `:1370`, `session-list-service.ts:135`, `:215` — `{}` (для
      `session_revoked` — `device`, якщо він уже є на місці виклику; інакше без нього);
    - `support-service.ts:483` — `supportReply` без змін виклику.
- [ ] `sign-in-method-notice.spec.ts`: фікстура `notice()` — `provider: 'github'` замість
      `providerTitle: 'GitHub'`; очікування `security(5n, 'sign_in_method_added')` → виклик
      `notify` з `'security.method_added', { provider: 'github' }`. Перевірки `to`, `subject` і
      тексту листа («GitHub», ім'я профілю) лишаються.
- [ ] Unit **незалежності листів** (поруч із тестами модулів):
    - для `notifyNewSignIn` (з `mail: true`), `notifySignInMethodAdded` і обох гілок
      `announcePasswordReset` — `notify` замокано так, що він падає на перевірці, вставці й push
      (через залежності сервісу, не мок `notify`): лист однаково відправлено;
    - email-скидання з `user.claimed: true` — `account_claimed` і `announcePasswordReset`; з
      `false` — `password_reset` і той самий лист.
- [ ] Наявні тести модулів листів (`new-sign-in-notice.spec.ts`, `password-reset-notice.*`,
      `oauth-*.pg.test.ts`) зелені без правок, крім тих, що перевіряли аргументи
      `userNotificationService.security` (лише заміна назви виду й `params`).

### T5 · HTTP API і сигнали — Р4, Р6, Р8

- [ ] Контракти (`backend/src/app/routes/contract-schemas/notifications.ts`) і реєстр
      (`contract-schemas/index.ts`):
      `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/:id/read`,
      `POST /notifications/read-all`, `GET /notifications/preferences`,
      `PUT /notifications/preferences`.
- [ ] `backend/src/app/services/notifications/notification-center-service.ts`: `list`,
      `unreadCount`, `markRead` (`null` → `notFound('…', 'notification_not_found')`), `readAll`,
      `getPreferences`, `updatePreference` (`locked` з `enabled: false` або недоступний канал →
      `422`). Після кожного успішного `markRead` (і повторного теж: так простіше, а зайвий сигнал
      дає лише одне перечитування), `readAll` і `updatePreference` — сигнал на шину.
- [ ] Transformer `transformers/notification-transformer.ts` (`bigint` → `string`, дати → ISO).
- [ ] `controllers/http/notifications/notification-controller.ts` за патерном контролерів
      (`AppResult`, хелпери). Параметри перевіряються правилами T1 до запиту в БД:
    - `:id`, що не проходить `isPgBigintId` (нечисловий, `0`, більший за межу `bigint`) —
      `404 notification_not_found`, як для чужого: існування не розкривається;
    - `before` чи `upTo` поза правилами, `limit` поза 1–50 — `422` валідації;
    - без `limit` — 20.
- [ ] `routes/http-routes.ts`: група `prefix: 'notifications'`,
      `middlewares: ['session_web', 'csrf_guard']`, `auth_guard` на кожному маршруті.
- [ ] `user-event-bus.ts` `BUS_EVENTS`: `notifications_changed`,
      `notification_preferences_changed`.
- [ ] Тести:
    - `route-access.spec.ts`: `auth_guard` на всіх `/notifications/*`, `csrf_guard` у групі;
      запис для `items[].params` поруч із `notificationLogs[].messageData`;
    - `route-contracts.spec.ts` зелений (реєстр, схеми);
    - HTTP PG (`services/notifications/notification-http.pg.test.ts`): сторінки й курсор;
      `read` чужого, відсутнього, нечислового id і `9223372036854775808` — однаковий
      `404 notification_not_found`, а чужий рядок після запиту має `read_at IS NULL`;
      `before=9223372036854775808` і `upTo=9223372036854775808` — `422`, без помилки
      PostgreSQL у лозі; список без `limit` повертає 20 записів із 25;
      повторний `read` — `200` з тим самим `link`; `read-all` з `upTo`; `PUT`
      `security.email:false` і `support.email:true` — `422`; `PUT support.push:false` → матриця;
      без сесії — `401`; без CSRF — відмова;
    - Redis (`user-event-bus.redis.test.ts`): обидві нові події проходять між двома інстансами,
      невідома — відкидається `parseEnvelope`.

### T6 · Задача `notifications-retention` — Р10

Скіл `scheduled-job`, вимоги «Adding a job» у `documentation/en/backend/scheduler.md`. Зразок —
`audit-events-retention`.

- [ ] `config/notifications-retention.ts`: `NOTIFICATIONS_RETENTION_DAYS` (за замовчуванням 90,
      мінімум 7) і розмір партії; `configError`; перевірка у `validate-runtime-config.ts`.
      `config/notifications-retention.spec.ts`.
- [ ] `services/notifications/notifications-retention-service.ts`:
      `purge({ before, dryRun, checkpoint })`; `checkpoint()` безпосередньо перед кожним SQL-кроком; `dryRun` →
      `countPurgeable`.
- [ ] `scheduler/jobs/notifications-retention.ts` (`defineJob`, щоденно, `timeout` у межах Р13
      планувальника): `cutoff` один раз на запуск; за помилки конфігу задача відмовляється
      працювати. Реєстрація в `jobs/index.ts`.
- [ ] `.env.example`: змінна з коментарем.
- [ ] Unit (`scheduler/jobs/notifications-retention.spec.ts`): `cutoff` з конфігу, `checkpoint`
      і `dryRun` передаються, відмова при помилці конфігу; `jobs/index.spec.ts` зелений.
- [ ] PG (`notifications-retention.pg.test.ts`): рядки по обидва боки `cutoff`; малий розмір
      партії; `checkpoint`, що кидає після першої партії, — наступного запиту немає; `dryRun`
      рахує ті самі рядки й нічого не видаляє; видаляються й прочитані, й непрочитані; два
      перекриті запуски видаляють кожен рядок рівно раз.

### T7 · Frontend — Р7, Р11

#### T7.1 · API і store

- [ ] `utils/api.ts`: `notificationsApi` — `list`, `unreadCount`, `markRead`, `readAll`,
      `getPreferences`, `updatePreference` за контрактами T5.
- [ ] `utils/ws-payload-guards.ts`: guard-и двох нових подій (порожній об'єкт).
- [ ] `stores/notifications.ts` (Pinia), Р11:
    - стан: `unreadCount`, `items` (перша сторінка й довантажені), `next`, `listOpen` (лічильник
      відкритих панелей і сторінок), `loaded`;
    - **життєвий цикл відкритого списку**: `openList()` збільшує `listOpen` і викликає
      `refreshSoon()`; `closeList()` зменшує, але не нижче нуля. Кожне відкриття має рівно одне
      закриття. Список вважається відкритим, поки `listOpen > 0`; тоді кожна точка відновлення
      перечитує і першу сторінку;
    - `seq` для кожного запиту, що читає або змінює лічильник; застосовується лише відповідь з
      `seq` більшим за останній застосований;
    - `refreshSoon()` з `REFRESH_COALESCE_MS = 300`; `inFlight` і `dirty`: виклик під час
      активного `GET` ставить `dirty`, після завершення (будь-яким результатом) — ще один `GET`;
    - кожне завершення `markRead` / `readAll` (успіх, помилка, загублена відповідь) —
      `refreshSoon()`;
    - перечитування: лічильник, і якщо `listOpen > 0` — перша сторінка;
    - підписки через `useEventBus`: `notifications_changed`, `ws_ready`; `document`
      `visibilitychange` → `visible`;
    - `reset()` збільшує `generation`; відповіді старого `generation` відкидаються.
- [ ] `composables/useSessionLifecycle.ts` `resetSessionScopedState`: `notificationsStore.reset()`.
- [ ] Unit (`stores/__tests__/notifications.spec.ts`), фейкові таймери й керовані проміси:
    - стара відповідь перечитування після нової відповіді `read` не змінює лічильник;
    - два `read`, що комітяться у зворотному порядку (A стартує першим, B другим, відповідь A
      приходить останньою й відкидається): після обох — ще один `GET`, бейдж дорівнює значенню
      сервера після обох;
    - сигнал або завершення мутації під час активного `GET` — рівно один додатковий `GET`; без
      нових подій цикл зупиняється;
    - кілька сигналів поспіль — один `GET`;
    - пропущений сигнал, потім `ws_ready` чи `visibilitychange` — оновлюються і лічильник, і
      перша сторінка відкритого списку;
    - `reset()` під час запиту — відповідь відкинута;
    - `openList()` / `closeList()`: при `listOpen = 0` `ws_ready` перечитує лише лічильник; після
      `openList()` — і першу сторінку; зайвий `closeList()` не робить лічильник від'ємним;
      `reset()` обнуляє `listOpen`.

#### T7.2 · Дзвоник і сторінка історії

- [ ] `components/NotificationBell.vue` у `AppHeader.vue`: бейдж (`.nav-badge`, «99+» при
      `unreadCount >= 100`), панель з останніми 10, «Позначити всі прочитаними» (`upTo` —
      найбільший id у store), «Усі сповіщення». `aria-expanded`, `aria-live="polite"` для
      лічильника. Відкриття панелі — `openList()`. Будь-яке закриття — `Esc`, клік поза
      панеллю, повторний клік по дзвонику, перехід на інший маршрут, `onUnmounted` — викликає
      `closeList()` рівно один раз (прапорець `open` у компоненті).
- [ ] `components/notifications/NotificationItem.vue`: заголовок і текст за ключами
      `notifications.<kind>.title` і `.body` з `params`, відносний час (`useDateFormat`,
      часовий пояс користувача), ознака непрочитаного; клік веде на
      `/notifications/<id>/open`.
- [ ] `views/NotificationsView.vue`: вкладки «Усі» / «Непрочитані» (`unread=1`), «Показати
      ще», порожній стан, стан помилки, повідомлення з `query.notice` (`gone`, `error`).
      `onMounted` — `openList()`, `onUnmounted` — `closeList()`. Тож `ws_ready` оновлює список
      на сторінці історії й тоді, коли дзвоник не відкривали.
- [ ] Маршрути в `router/index.ts`: `/notifications` і `/notifications/:id/open`
      (`requiresAuth`), lazy-імпорт.
- [ ] `views/NotificationOpenView.vue` (Р7): `markRead` → `link` — `router.replace(link)`;
      `link: null` — `/notifications`; `404` — `/notifications?notice=gone`; інша помилка —
      `/notifications?notice=error` і `refreshSoon()`, локальний стан прочитаності не змінюється.
- [ ] Прокрутка до хешу: `scrollBehavior` у `createRouter` або в `UserAccount.vue` — після
      монтування `ActiveSessions` прокрутити до `route.hash` (`#sessions`). Обрати один спосіб,
      що працює і при першому завантаженні, і при переході в SPA.
- [ ] Локалі `uk.ts`, `en.ts`, `pl.ts`: `notifications.<kind>.title` / `.body` для 9 видів,
      тексти дзвоника, сторінки, порожнього стану, повідомлень `gone` / `error`, налаштувань.
- [ ] Unit: `NotificationBell.spec.ts` (бейдж, «99+», `upTo`; кожен спосіб закриття дає рівно
      один `closeList()`, а відкриття й розмонтування без закриття — теж один),
      `NotificationOpenView.spec.ts` (`link`, `link: null`, `404`, мережева помилка без зміни
      стану і з перечитуванням), `NotificationsView.spec.ts` (вкладки, «Показати ще»;
      монтування — `openList()`, розмонтування — `closeList()`), тест локалей: кожен вид із
      `NOTIFICATION_KINDS` має ключі в усіх трьох мовах.

#### T7.3 · Налаштування

- [ ] `components/account/NotificationPreferences.vue` на сторінці акаунта поруч із перемикачем
      push пристрою: матриця з `GET /notifications/preferences`; `locked` — вимкнений перемикач
      з підказкою «Обов'язково для безпеки»; зміна — `PUT`, відповідь замінює матрицю; помилка —
      відкат перемикача й повідомлення. Перечитування на `ws_ready` і
      `notification_preferences_changed`.
- [ ] `stores/push.ts`: без `notificationTypes` (зроблено в T2), перевірити підписку і тест
      `push-account-switch`.
- [ ] Unit `NotificationPreferences.spec.ts`: `locked` не вмикається/вимикається, помилка `PUT`
      відкочує, сигнал перечитує.
- [ ] `check-bundle-graph` (ADR 0005) зелений: сторінки сповіщень — lazy-чанки.

### T8 · E2E — Р12

- [ ] `frontend/e2e/` з моком бекенду: бейдж після сигналу `notifications_changed`; «Позначити
      всі прочитаними»; відкриття елемента веде на `link`; вимкнення push для `support`;
      заблокований security-email.
- [ ] `frontend/e2e-live/notifications.spec.ts`, два браузери одного користувача (A і B):
    - вхід у третьому контексті → у A і B з'являється бейдж без перезавантаження;
    - прочитання в A → лічильник у B зменшується;
    - пропущений сигнал: у B відкрито `/notifications`, з'єднання B розірване
      (`context.setOffline(true)`) на час нового входу, після відновлення й `ws_ready` у B
      оновлюються і бейдж, і список;
    - пряме відкриття `/notifications/<id>/open` у контексті без сесії → вхід → сповіщення
      прочитане, відкрито `/account`, видима секція `#sessions`.
- [ ] Наявні live-специфікації (`active-sessions`, `push-account-switch`, `sign-in-redirect`)
      зелені.

### T9 · Документація — Р13

- [ ] `documentation/backend/notifications.md` і `documentation/en/backend/notifications.md`:
      модель і колонки, каталог видів, категорії й політика каналів, гарантія best effort і
      незалежність security-листів, API (курсор, `404`, `read-all` і `id <= upTo`, лічильник
      до 100), сигнали й точки відновлення, правило `link` і сумісність service worker, строк
      зберігання, «Як додати новий вид» (каталог, міграція `CHECK`, тексти push, локалі).
      Посилання на джерела на GitHub.
- [ ] Сайдбари обох локалей (`documentation/.vitepress/config.ts`), `KEY_PAGES` і `EN_KEY_PAGES`
      (`documentation/scripts/verify-dist.mjs`).
- [ ] Оновити в обох локалях: `web-push-notification.md` (без `notification_types`, push за
      категорією, `url` відкриття), `account.md` (налаштування), `websocket.md` (події),
      `scheduler.md` (задача, змінна), `configuration.md` (змінна), `database.md` (таблиці,
      видалена колонка).
- [ ] `pnpm docs:build && pnpm docs:verify`.

### T10 · Перевірка, рев'ю, закриття

- [ ] `make check`; `make test-pg` і `make test-redis` з кількістю виконаних і пропущених;
      `test:e2e`, `test:e2e:live`; `pnpm docs:build && pnpm docs:verify`.
- [ ] Мутації — кожна ламає названий тест, результат у `progress.md`:

    | Мутація                                                 | Тест, що падає                              |
    | ------------------------------------------------------- | ------------------------------------------- |
    | `notify` кидає з першого кроку (без обгортки)           | незалежність листів (T4.3)                  |
    | push лише за наявності `id`                             | збій вставки → push (T4.1)                  |
    | `url` відкриття без рядка                               | збій вставки → `url = link` (T4.1)          |
    | `markRead`: `user_id` лише в `SELECT`, не в `UPDATE`    | чужий рядок має `read_at IS NULL` (T3, T5)  |
    | `:id`/`before`/`upTo` без межі `bigint`                 | `9223372036854775808` → `404`/`422` (T5)    |
    | збій читання налаштувань → `default`                    | збій читання → жодного `sendPush` (T4.2)    |
    | `closeList()` не викликається при закритті панелі       | `NotificationBell.spec.ts` (T7.2)           |
    | `markAllUpTo` без `id <= upTo`                          | новіший лишається непрочитаним (T3)         |
    | `LIMIT 100` після `COUNT(*)`                            | 150 непрочитаних → 100 (T3)                 |
    | лічильник у payload WS і застосування його в store      | два `read` у зворотному порядку (T7.1)      |
    | прибрати `dirty`                                        | сигнал під час `GET` → ще один `GET` (T7.1) |
    | прибрати перечитування на `ws_ready`                    | пропущений сигнал (T7.1, T8)                |
    | `locked` не перевіряється в `PUT`                       | `security.email:false` → `422` (T5)         |
    | push не читає налаштувань категорії                     | вимкнений `support.push` (T4.2)             |
    | мережева помилка відкриття позначає прочитаним локально | `NotificationOpenView.spec.ts` (T7.2)       |

- [ ] `job:run notifications-retention --dry-run` на сидованих старих рядках, потім без
      `--dry-run`: лічильники збігаються.
- [ ] Ручний прохід (golden path плану):
    - вхід з другого браузера → у першому сповіщення й бейдж без перезавантаження;
    - клік по push відкриває `/account` на секції `#sessions`, непрочитаність зникає на обох
      пристроях;
    - вийти, відкрити посилання з push → після входу та сама сторінка;
    - вимкнути push для `support` → відповідь підтримки при відкритій вкладці є в історії, push
      немає;
    - `PUT` `security.email:false` → `422`.
- [ ] `progress.md` → Evidence of Completion; PR `feat/notification-center` → `main`; окремий PR
      статусу `review`.
- [ ] Після рев'ю й мерджу — PR «Mark feat-236 done»: `done`, evidence (PR, CI, лічильники),
      видалити `feature-state/feat-236/`.
