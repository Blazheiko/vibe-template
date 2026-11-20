# Центр сповіщень

Кожне сповіщення користувача спершу зберігається в застосунку, і лише потім, за налаштуваннями користувача, надсилається push. Історію видно на будь-якому пристрої, навіть якщо push закрито або ніколи не дозволено. Непрочитані позначені й пораховані в шапці. Клік по сповіщенню, у списку чи в push, відкриває об'єкт і позначає сповіщення прочитаним на всіх пристроях. На сторінці акаунта є налаштування push для кожної категорії; обов'язкові канали показано, але вимкнути їх не можна (feat-236).

Джерела: каталог [`shared/src/notifications/catalog.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/notifications/catalog.ts), схеми параметрів [`schemas/notifications/params.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/notifications/params.ts), доставка [`notification-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/notifications/notification-service.ts), API [`notification-center-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/notifications/notification-center-service.ts), store [`stores/notifications.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/stores/notifications.ts).

## Гарантія: best effort

Рядок, сигнал і push пишуться у фоні після коміту бізнес-зміни, як і push раніше. Якщо процес зупиниться до вставки, подія не потрапить ні в історію, ні в push. Якщо вставка не вдасться, push усе одно піде (на звичайне посилання виду), а в історії запису не буде. Повна історія потребує запису події в транзакції зміни (надійна доставка, поза цією фічею). Security-листи — окремий потік у місцях виклику: сповіщення їх не запускає і не зупиняє.

## Таблиці

`notifications` (міграція [`20261120170831_notification_center`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/drizzle/migrations/20261120170831_notification_center/migration.sql)):

| Колонка      | Тип                               | Значення                                       |
| ------------ | --------------------------------- | ---------------------------------------------- |
| `id`         | `bigserial`                       | рядок в API; він же курсор сторінки            |
| `user_id`    | `bigint`, FK `users`, `cascade`   | видалення акаунта видаляє його історію         |
| `category`   | `varchar(32)`, `CHECK IN (…)`     | `security`, `support`                          |
| `kind`       | `varchar(64)`, `CHECK IN (…)`     | ключ каталогу                                  |
| `params`     | `jsonb`                           | лише ключі виду, не більше 1024 байтів         |
| `link`       | `varchar(512)`, починається з `/` | сторінка, яку відкриває сповіщення, або `NULL` |
| `created_at` | `timestamp`                       |                                                |
| `read_at`    | `timestamp`                       | `NULL`: непрочитане                            |

Індекси: `(user_id, id DESC)` для сторінок, частковий із `WHERE read_at IS NULL` для лічильника й фільтра непрочитаних, `(created_at)` для строку зберігання.

`notification_preferences`: первинний ключ `(user_id, category, channel)`, `enabled`, `updated_at`. Рядка немає — діє значення за замовчуванням із каталогу.

## Каталог видів

Текст не зберігається: клієнт будує його з `kind` і `params` мовою інтерфейсу (`notifications.kinds.<вид, де . замінено на _>` у локалях). Push і листи лишаються англійською на сервері ([`notification-push-texts.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/notifications/notification-push-texts.ts)).

| Вид                         | Категорія  | `params`       | `link`              | Лист (у місці виклику, без змін)                           |
| --------------------------- | ---------- | -------------- | ------------------- | ---------------------------------------------------------- |
| `security.new_sign_in`      | `security` | `{ device }`   | `/account#sessions` | підтверджена адреса, не знайомий пристрій, ліміт на годину |
| `security.method_added`     | `security` | `{ provider }` | `/account`          | адреса акаунта                                             |
| `security.method_removed`   | `security` | `{ provider }` | `/account`          | немає                                                      |
| `security.password_changed` | `security` | `{}`           | `/account`          | немає                                                      |
| `security.password_reset`   | `security` | `{}`           | `/account`          | лист про скидання                                          |
| `security.logout_all`       | `security` | `{}`           | `/account`          | немає                                                      |
| `security.session_revoked`  | `security` | `{ device? }`  | `/account#sessions` | немає                                                      |
| `security.account_claimed`  | `security` | `{}`           | `/account`          | лист про скидання, якщо claim стався через скидання поштою |
| `support.reply`             | `support`  | `{}`           | `/support`          | немає                                                      |

`device` — підпис на кшталт «Chrome on macOS», `provider` — id OAuth-провайдера. IP, email, телефон, User-Agent і id сесій не зберігаються: подробиці входу лишаються в списку сесій і в листі.

## Канали й налаштування

| Категорія  | У застосунку | Push                      | Email                              |
| ---------- | ------------ | ------------------------- | ---------------------------------- |
| `security` | завжди       | налаштовується, увімкнено | завжди увімкнено (де вид шле лист) |
| `support`  | завжди       | налаштовується, увімкнено | немає                              |

Push категорії, яку користувач вимкнув, не надходить на жоден пристрій. Якщо налаштування не вдалося прочитати, push пропускається, а не йде за значенням за замовчуванням: воно могло б перекрити збережене `false`. Перемикач push на сторінці акаунта стосується підписки цього пристрою, а налаштування — категорій. Тестовий push їх не враховує.

## API

Усі маршрути — у групі з `session_web`, `csrf_guard` і `auth_guard`; кожен запит обмежений користувачем сесії.

| Маршрут                           | Відповідь                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /notifications`              | `{ items, next, unreadCount }`; `unread=1`, `before=<id>`, `limit` 1–50 (за замовчуванням 20), новіші першими |
| `GET /notifications/unread-count` | `{ unreadCount }`, не більше 100 (клієнт показує «99+»)                                                       |
| `POST /notifications/:id/read`    | `{ link, unreadCount }`; ідемпотентний: уже прочитане відповідає тим самим посиланням                         |
| `POST /notifications/read-all`    | `{ upTo }` → `{ unreadCount }`: усі сповіщення з `id <= upTo`, зокрема зі старших сторінок                    |
| `GET /notifications/preferences`  | `{ preferences: [{ category, channel, enabled, locked }] }`                                                   |
| `PUT /notifications/preferences`  | `{ category, channel, enabled }` → матриця                                                                    |

- Сповіщення іншого користувача, відсутнє, з некоректним id і з id поза межею PostgreSQL `bigint` дають однаковий `404`: існування не розкривається.
- `before` чи `upTo` поза `bigint` — `400` (`invalid_cursor`, `invalid_up_to`); `limit` поза 1–50 — `422` валідації. Id перевіряються до будь-якого запиту.
- Заблокований канал або канал, якого в категорії немає, — `400` з `reason` `channel_locked` чи `channel_unavailable`.
- `read-all` гарантує `id <= upTo`, а не «лише показані»: `bigserial` впорядковує id за видачею, а не за комітом, тож паралельна вставка з меншим id, закомічена пізніше, теж буде позначена.
- Лічильник — `COUNT(*)` над підзапитом із `LIMIT 100` по частковому індексу.

## Реальний час

Дві події [шини подій користувача](/backend/websocket), обидві з порожнім payload: `notifications_changed` (вставка, прочитання, «прочитати всі») і `notification_preferences_changed`. Сигнал навмисно не несе значення: шина доставляє локально й через Redis двома незалежними шляхами, тож запізнілий лічильник міг би перезаписати новішу відповідь. Клієнт перечитує стан на сигнал і в точках відновлення, бо шина не повторює подій, а задача строку зберігання сигналів не шле: на кожен `ws_ready`, коли вкладка знову видима, коли відкрито панель чи сторінку історії. Близькі перечитування об'єднуються (300 мс), запит під час активного читання дає ще одне читання після нього, старіша відповідь відкидається, як і будь-яка відповідь для попереднього акаунта.

## Відкриття сповіщення

Маршрут фронтенду `/notifications/:id/open` викликає `POST …/read` і замінює себе на `link` із відповіді (разом із фрагментом; сторінка прокручується до секції, щойно вона з'являється). Без посилання — `/notifications`; `404` — туди ж із повідомленням «більше немає»; інша помилка — з повідомленням про помилку, а стан прочитаності перечитується (сервер міг закомітити прочитання). Без сесії роутер веде на вхід і повертає назад. Push відкриває цей маршрут, якщо сповіщення збережено; інакше — посилання виду.

Service worker зберігає своє ширше правило ([`resolveNotificationTarget`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/notification-target.ts): URL того самого origin або шлях); те, що зберігає сервер, суворіше (`isNotificationLink`: один `/` на початку, без схеми й хоста).

## Строк зберігання

Задача [планувальника](/backend/scheduler) `notifications-retention` щодня о 04:30 UTC видаляє сповіщення, старші за `NOTIFICATIONS_RETENTION_DAYS` (за замовчуванням 90, мінімум 7), прочитані чи ні, партіями по `NOTIFICATIONS_PURGE_BATCH_SIZE` (за замовчуванням 1000).

## Як додати вид

1. Додати його в `NOTIFICATION_KINDS` і `NotificationParamsMap` у `shared/src/notifications/catalog.ts`, а схему — в `NotificationParamsSchemas` (перевірка під час компіляції тримає їх узгодженими).
2. Додати текст push у `notification-push-texts.ts`, а заголовок і текст — у три локалі (без них падає тест).
3. Згенерувати міграцію: `CHECK` колонки `notifications.kind` будується з каталогу.
4. Викликати `notificationService.notify(userId, kind, params)` після коміту зміни. Нова категорія потребує ще політики каналів у `NOTIFICATION_CHANNEL_POLICY` і назви в локалях.
