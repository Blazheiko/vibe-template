# Швидкий старт

Ця сторінка проводить від чистого клону до запущених backend і frontend на локальній машині. Кожен крок перевірено на чистому клоні репозиторію.

## Передумови

| Інструмент | Версія                               | Джерело                                                                                                                                                               |
| ---------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js    | `24.22.2` (вимога `^24.22.2`)        | [.nvmrc](https://github.com/Blazheiko/vibe-template/blob/main/.nvmrc), [package.json](https://github.com/Blazheiko/vibe-template/blob/main/package.json)              |
| pnpm       | `>=9.0.0`, зафіксовано `pnpm@9.15.0` | [package.json](https://github.com/Blazheiko/vibe-template/blob/main/package.json) (`engines`, `packageManager`)                                                       |
| PostgreSQL | з розширенням **pgvector**           | [create-database.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/db/create-database.ts) виконує `CREATE EXTENSION IF NOT EXISTS vector` |
| Redis      | будь-яка сучасна версія              | [config/redis.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/redis.ts)                                                          |

Структуру репозиторію описано в розділі [Структура проєкту](/guide/project-structure).

### PostgreSQL і Redis через Docker

pgvector потрібен для пошуку в базі знань Support AI, і тип `vector` є в самій схемі, тому розширення обов'язкове навіть без AI. Звичайний образ `postgres` його не містить, і `db:create` на ньому впаде. Використовуйте образ `pgvector/pgvector`. Пояснення та інші способи встановлення: [База даних → pgvector](/backend/database#pgvector).

```bash
docker run -d --name vibe-pg \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=<your-pg-password> \
  -p 5432:5432 pgvector/pgvector:pg16

docker run -d --name vibe-redis \
  -p 6379:6379 redis:7 redis-server --requirepass <your-redis-password>
```

## 1. Клонування та встановлення залежностей

```bash
git clone https://github.com/Blazheiko/vibe-template.git
cd vibe-template
nvm use          # бере версію з .nvmrc
pnpm install
```

## 2. Файл `.env` для backend

```bash
cp packages/backend/.env.example packages/backend/.env
```

Для локальної розробки змініть у `packages/backend/.env` такі змінні:

```dotenv
APP_KEY=<random-string-at-least-32-chars>

PGSQL_HOST=127.0.0.1
PGSQL_PORT=5432
PGSQL_USER=postgres
PGSQL_PASSWORD=<your-pg-password>
PGSQL_DB_NAME=vibe_template

REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=<your-redis-password>

# хост і порт, за якими браузер підключається до WebSocket
DOMAIN=127.0.0.1:3000

# demo-акаунти для першого входу (див. крок 3)
SEED_ADMIN_EMAIL=admin@example.com
SEED_ADMIN_PASSWORD=<admin-password-8-32-chars>
SEED_USER_EMAIL=user@example.com
SEED_USER_PASSWORD=<user-password-8-32-chars>

# у репозиторії немає каталогу packages/backend/public
SERVE_STATIC=false
```

Пояснення:

- **База даних** читається лише зі змінних `PGSQL_*` ([config/database.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/database.ts)); ті самі значення бере drizzle-kit ([`drizzle.config.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/drizzle.config.ts)). Незадані змінні отримують defaults `127.0.0.1:5432`, `postgres`, база `vibe_template`.
- **Redis**: `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_PREFIX` ([config/redis.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/redis.ts)). Якщо Redis запущено без пароля, залиште `REDIS_PASSWORD` порожнім.
- **`SERVE_STATIC`**: у `.env.example` стоїть `false`, бо в dev фронтенд віддає Vite. `true` потрібне лише тоді, коли в `packages/backend/public` лежить зібраний фронтенд; без цього каталогу сервер пише попередження і стартує без статики.
- **`DOMAIN`** разом з портом: фронтенд підключається до WebSocket за адресою `ws://<DOMAIN>/api/websocket`. Без порту браузер піде на порт 80, вхід працюватиме, але в шапці буде статус **Disconnected** і real-time функції не працюватимуть.
- **`SEED_*`** — логіни й паролі demo-акаунтів, які створить `db:seed --demo`. Пароль має бути від 8 до 32 символів (як у формі входу). Це локальні тестові значення, не використовуйте їх деінде.
- **`APP_KEY`** потрібен для хешування OTP, коли ввімкнено phone-auth (мінімум 32 символи, див. [validate-runtime-config.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/start/validate-runtime-config.ts)). Із `AUTH_PHONE_ENABLED=false` сервер стартує і без нього, але краще задати його одразу.

Повний перелік змінних з defaults наведено на сторінці [Конфігурація](/backend/configuration).

### Що потрібно зараз, а що можна налаштувати пізніше

Для першого запуску потрібні лише PostgreSQL (з pgvector) і Redis. Усі інтеграції в `.env.example` вимкнені або порожні, і сервер з ними стартує. Поведінку без кожного сервісу перевірено на чистому `.env` з `.env.example`.

| Сервіс                           | Для запуску     | Змінні                                             | Що відбувається без нього                                                                                                                                        | Детальніше                                                  |
| -------------------------------- | --------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| PostgreSQL + pgvector            | **обов'язково** | `PGSQL_*`                                          | Сервер не працює. Без pgvector падає вже `db:create`: тип `vector` є в схемі, навіть якщо AI вам не потрібен                                                     | [База даних](/backend/database#pgvector)                    |
| Redis                            | **обов'язково** | `REDIS_*`                                          | Немає сесій: вхід неможливий                                                                                                                                     | [Автентифікація](/backend/auth)                             |
| SMTP                             | ні              | `SMTP_ENABLED`, `SMTP_*`                           | Листи не надсилаються. `forgot-password` відповідає `200`, але лист не йде, у лозі `Email service is not configured`. Demo-акаунти вже мають підтверджений email | [Пошта](/backend/mail)                                      |
| S3 / MinIO                       | ні              | `S3_*`, `CDN_URL`                                  | Завантаження аватара повертає `500 Failed to upload avatar`; скриншоти статей бази знань не зберігаються                                                         | [Сховище файлів](/backend/storage)                          |
| AI-провайдер                     | ні              | `AI_TEXT_DRIVER`, `OPENAI_*`, `XAI_*`, `MISTRAL_*` | Чат підтримки показує `Failed to open support chat`, у лозі `OpenAI is not configured`. Embeddings для бази знань потребують саме `OPENAI_API_KEY`               | [AI](/backend/ai)                                           |
| VAPID-ключі (Web Push)           | ні              | `VAPID_*`                                          | `GET /api/push-subscriptions/vapid-public-key` → `500 VAPID keys not configured`, push-підписка неможлива                                                        | [Web Push](/backend/web-push-notification#генерація-ключів) |
| SMS-провайдер                    | ні              | `AUTH_PHONE_ENABLED`, `AUTH_SMS_*`                 | Вхід і реєстрація по телефону вимкнені: `400 Phone authentication is disabled`                                                                                   | [Автентифікація](/backend/auth#способи-входу)               |
| OAuth (Google, GitHub, Facebook) | ні              | `GOOGLE_*`, `GITHUB_*`, `FACEBOOK_*`               | Кнопки входу через соцмережі ведуть на сторінку провайдера з порожнім `client_id`, і провайдер показує помилку                                                   | [Автентифікація](/backend/auth#способи-входу)               |
| Sentry                           | ні              | `SENTRY_*`                                         | Помилки лише в логах                                                                                                                                             | [Observability](/backend/observability)                     |

Підключайте інтеграції тоді, коли до них дійде ваш сценарій: змінні описано на сторінці [Конфігурація](/backend/configuration).

## 3. База даних

Команди запускаються з workspace backend:

```bash
pnpm --filter backend db:create    # створює БД і розширення vector
pnpm --filter backend db:migrate   # drizzle-kit migrate
pnpm --filter backend db:seed      # початкові промпти; з --demo ще й demo-акаунти
```

Очікуваний вивід:

```text
Database "vibe_template" created successfully.
Extension "vector" ensured in database "vibe_template".
...
[✓] migrations applied successfully!
```

`db:create` можна запускати повторно: для наявної БД він виводить `Database "vibe_template" already exists.`

::: info Seed
`db:seed` вставляє початкові AI-промпти й безпечний для повторного запуску. Щоб отримати адміна для локальної роботи, задайте `SEED_ADMIN_EMAIL` і `SEED_ADMIN_PASSWORD` у `.env` (опційно `SEED_USER_*`) і виконайте `pnpm --filter backend db:seed --demo`. Запускайте seed до `pnpm dev`, бо промпти кешуються на старті. Деталі: [База даних → Seed](/backend/database#seed).
:::

Детальніше про схему та міграції: [База даних](/backend/database).

## 4. Запуск

```bash
pnpm dev
```

Скрипт збирає `shared` і `backend`, а потім паралельно запускає dev-сервери backend і frontend ([package.json](https://github.com/Blazheiko/vibe-template/blob/main/package.json)). Після старту:

| Сервіс                     | URL                                                                     | Джерело                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Backend (HTTP + WebSocket) | `http://localhost:3000` (`PORT`, `HOST=0.0.0.0`)                        | [config/app.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/app.ts) |
| Frontend (Vite)            | `http://localhost:5173`; `/api` і `/ws` проксюються на `127.0.0.1:3000` | [vite.config.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/vite.config.ts)  |

У лозі backend має з'явитися рядок `Listening http://0.0.0.0:3000`, а у Vite рядок `Local: http://localhost:5173/`.

Пакети можна запускати й окремо: `pnpm dev:backend` / `pnpm dev:frontend` (див. [Скрипти](/reference/scripts)).

## 5. Перевірка health

Маршрут `GET /ping` оголошено в [http-routes.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts). HTTP-маршрути мають префікс `API_PATH_PREFIX`, за замовчуванням `api`:

```bash
curl -i http://127.0.0.1:3000/api/ping
```

```text
HTTP/1.1 200 OK
content-type: application/json
...
{"status":"ok"}
```

Через Vite-проксі той самий запит працює на `http://localhost:5173/api/ping`.

## 6. Перший сценарій: від входу до виходу

`/api/ping` показує, що сервер живий. Тепер пройдіть шлях звичайного користувача, щоб побачити, що вже вміє шаблон. Потрібні demo-акаунти з кроку 3 (`db:seed --demo`).

### Увійти

Відкрийте `http://localhost:5173`, натисніть **Sign In** і введіть `SEED_ADMIN_EMAIL` та `SEED_ADMIN_PASSWORD` з вашого `.env`.

![Форма входу](/screenshots/login.jpg)

**Очікуваний результат:** відкривається сторінка акаунта, а в шапці праворуч зелений статус **Connected**. Це означає, що відкрилося WebSocket-з'єднання.

![Сторінка акаунта після входу](/screenshots/account.jpg)

На сторінці акаунта вже працюють зміна пароля, прив'язка телефону й email, тема та розмір шрифту. Аватар завантажується, якщо налаштовано S3 (див. таблицю вище).

### Подивитися запити в DevTools

Відкрийте DevTools → **Network** і оновіть сторінку.

| Що знайти                    | Що там побачити                                                                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/login`       | Тіло запиту з email і паролем. У відповіді `{"status":"success","user":{...},"wsUrl":...,"wsToken":...,"csrfToken":...}` і [заголовок](/reference/glossary#header-заголовок) `Set-Cookie: uapi=...; HttpOnly; SameSite=Lax` |
| `GET /api/main/init`         | Запит при кожному завантаженні застосунку. Cookie `uapi` браузер надсилає сам. Відповідь — дані користувача, `wsUrl`, `wsToken`, новий `csrfToken`                                                                          |
| `websocket` (фільтр **WS**)  | З'єднання `ws://127.0.0.1:3000/api/websocket` зі статусом `101`. На вкладці **Messages** видно повідомлення, якими обмінюються клієнт і сервер                                                                              |
| будь-який `POST` після входу | Заголовок `x-csrf-token` — фронтенд додає його сам                                                                                                                                                                          |

Відповідь `GET /api/main/init` для залогіненого користувача (токени скорочено):

```json
{
    "status": "ok",
    "csrfToken": "<…>",
    "user": {
        "id": "1",
        "name": "Admin",
        "email": "admin@example.com",
        "phone": null,
        "emailVerified": true,
        "emailVerifiedAt": "2026-10-25T15:05:42.229Z",
        "avatar": null,
        "role": "admin",
        "createdAt": "2026-10-25T17:05:42.143Z",
        "updatedAt": "2026-10-25T17:05:42.143Z"
    },
    "wsUrl": "ws://127.0.0.1:3000/api/websocket",
    "wsToken": "<…>",
    "storage": {
        "cdnUrl": "",
        "s3Prefix": "app",
        "s3StaticDataPrefix": "public",
        "s3DynamicDataPrefix": "uploads"
    }
}
```

Що тут відбувається, пояснено на сторінці [Як влаштований бекенд](/guide/how-backend-works#як-працюють-сесіі).

### Відкрити адмінку

Demo-адмін має роль `admin`, тому йому доступна адмін-панель: відкрийте `http://localhost:5173/admin/user-online`.

**Очікуваний результат:** у списку **User Online** є ви. Відкрийте застосунок в іншому браузері (або вікні інкогніто) і увійдіть як `SEED_USER_EMAIL`: у списку з'явиться **Demo User** без оновлення сторінки, бо адмінка отримує подію через WebSocket.

![Користувачі онлайн в адмінці](/screenshots/admin-online.jpg)

### Вийти

Натисніть меню (☰) праворуч у шапці → **Logout**.

**Очікуваний результат:** відкривається форма входу. Запит `GET /api/main/init` тепер повертає `401`:

```json
{
    "status": "error",
    "code": "unauthorized",
    "message": "Session expired or not found",
    "csrfToken": "<…>"
}
```

Сесію видалено з Redis, тож стара [cookie](/reference/glossary#cookie) більше нічого не відкриває.

### Те саме через curl

Цей сценарій можна пройти без браузера. Cookie зберігаються у файлі `cookies.txt`, а CSRF-токен береться з відповіді `init`. Токен потрібен навіть для входу: `init` спершу створює гостьову сесію, і запит входу має прийти з її токеном. Браузер сам додає до `POST` заголовок `Origin`, а curl — ні, тому його треба передати явно: без нього сервер відповість `403` ([чому так](/guide/csrf)).

```bash
B=http://127.0.0.1:3000/api
# Origin фронтенду: у dev сервер довіряє origin з APP_URL і FRONTEND_URL
O='origin: http://localhost:5173'

# 0. гостьова сесія і CSRF-токен: POST без токена сервер відхилить
CSRF=$(curl -s -c cookies.txt -b cookies.txt $B/main/init | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')

# 1. вхід: сервер ставить cookie сесії
curl -s -c cookies.txt -b cookies.txt -H "$O" -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -d '{"email":"user@example.com","password":"<user-password>","token":""}' $B/auth/login

# 2. хто я: cookie йде автоматично
curl -s -b cookies.txt $B/main/init

# 3. вихід: після входу токен новий, беремо його знову з init
CSRF=$(curl -s -b cookies.txt -c cookies.txt $B/main/init | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')
curl -s -b cookies.txt -c cookies.txt -X POST -H "$O" -H "x-csrf-token: $CSRF" $B/auth/logout

# 4. після виходу: 401
curl -s -o /dev/null -w '%{http_code}\n' -b cookies.txt $B/main/init
```

Поле `token` у тілі входу обов'язкове за схемою [`login.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/auth/login.ts); фронтенд передає порожній рядок. Без нього сервер відповість `422 validation_failed`.

## Усунення проблем

| Симптом                                                                                                     | Причина та рішення                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ENOENT ... scandir '.../packages/backend/public'` під час старту                                           | Увімкнено `SERVE_STATIC=true`. Встановіть `SERVE_STATIC=false` або створіть каталог `packages/backend/public`.                           |
| `db:create` падає на `CREATE EXTENSION ... vector`                                                          | У PostgreSQL немає pgvector. Візьміть образ `pgvector/pgvector` або встановіть розширення.                                               |
| `ECONNREFUSED` / помилка автентифікації під час `db:*`                                                      | Перевірте `PGSQL_HOST`, `PGSQL_PORT`, `PGSQL_USER`, `PGSQL_PASSWORD`.                                                                    |
| Помилки Redis (`NOAUTH`, `ECONNREFUSED`)                                                                    | `REDIS_PASSWORD` і `REDIS_PORT` мають збігатися з налаштуваннями сервера Redis.                                                          |
| `bind: address already in use` для 5432/6379/3000/5173                                                      | Порт уже зайнятий. Звільніть його або змініть порт (`-p <host-port>:5432` у Docker плюс відповідна змінна в `.env`, `PORT` для backend). |
| Сервер пише `start success`, але `curl /api/ping` дає `connection refused`, у лозі `Listening unix socket:` | `APP_UNIX_PATH=` порожнє, а версія коду ще не містить виправлення. Видаліть рядок `APP_UNIX_PATH` з `.env`.                              |
| Після входу в шапці **Disconnected**, у консолі `WebSocket error`, `1006`                                   | `DOMAIN` без порту. Встановіть `DOMAIN=127.0.0.1:3000` і перезапустіть backend.                                                          |
| `pnpm install` скаржиться на engines                                                                        | Перемкніться на Node із `.nvmrc` (`nvm use`) і pnpm `>=9`.                                                                               |
| Phone-auth не стартує через OTP-секрет                                                                      | Задайте `APP_KEY` або `AUTH_OTP_HMAC_KEY` довжиною від 32 символів.                                                                      |

::: tip Наступний крок
[Як влаштований бекенд](/guide/how-backend-works): що відбулося з кожним запитом, який ви щойно бачили в DevTools.
:::
