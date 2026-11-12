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

PostgreSQL і Redis не обов'язково встановлювати: з Docker їх (а також S3 і пошту) запускає одна команда, див. [Сервіси через Docker Compose](#сервіси-через-docker-compose) у кроці 2.

pgvector потрібен для пошуку в базі знань Support AI, і тип `vector` є в самій схемі, тому розширення обов'язкове навіть без AI. Звичайний образ `postgres` його не містить, і `db:create` на ньому впаде. Якщо ставите PostgreSQL самі, візьміть образ `pgvector/pgvector` або встановіть розширення: [База даних → pgvector](/backend/database#pgvector).

## 1. Клонування та встановлення залежностей

```bash
git clone https://github.com/Blazheiko/vibe-template.git
cd vibe-template
nvm use          # бере версію з .nvmrc
make setup       # перевірка Node/pnpm/Docker, pnpm install, .env з .env.example, збірка shared
```

`make setup` — перший крок через [Makefile](/reference/make), єдину точку входу для команд розробника; `make` без аргументів показує всі цілі.

::: tip Альтернатива: pnpm без make
`make` не обов'язковий. Кожна ціль лише викликає pnpm-скрипт, тому весь цей гайд можна пройти через `pnpm`: `pnpm install` замість `make setup`, `pnpm services:up` замість `make services-up`, `pnpm --filter backend db:migrate` замість `make db-migrate`, `pnpm dev` замість `make dev`, `pnpm app:up` / `pnpm app:down` для застосунку в Docker. Відповідність усіх цілей і скриптів — у [Команди make](/reference/make); `make -n <ціль>` друкує команду без запуску.
::: На Windows використовуйте WSL2: [Команди make → Windows](/reference/make#windows).

## 2. Файл `.env` для backend

`make setup` уже створив файл з `.env.example` (окремо: `make env`; наявний `.env` не перезаписується). Без `make`:

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

### Сервіси через Docker Compose

[docker-compose.yml](https://github.com/Blazheiko/vibe-template/blob/main/docker-compose.yml) у корені запускає все, з чим говорить backend локально. Сам backend і frontend при цьому працюють на хості через `pnpm dev`. Як запустити в контейнерах і застосунок, описано нижче: [Увесь застосунок у Docker Compose](#увесь-застосунок-у-docker-compose).

| Сервіс   | Образ                    | Порт на `127.0.0.1`                          | Для чого                                                    |
| -------- | ------------------------ | -------------------------------------------- | ----------------------------------------------------------- |
| postgres | `pgvector/pgvector:pg16` | `PGSQL_PORT` (5432)                          | база даних з pgvector                                       |
| redis    | `redis:7-alpine`         | `REDIS_PORT` (6379)                          | сесії, WebSocket, throttling                                |
| s3       | `chrislusf/seaweedfs`    | `S3_HOST_PORT` (8333)                        | S3-сумісне сховище: аватари, скриншоти бази знань           |
| mailpit  | `axllent/mailpit`        | `SMTP_PORT` (1025), `MAILPIT_UI_PORT` (8025) | перехоплює всі листи, веб-інтерфейс `http://localhost:8025` |

```bash
make services-up     # pnpm services:up: docker compose --env-file packages/backend/.env up -d --wait
make services-down   # зупинити (і застосунок, якщо він запущений), дані лишаються у volumes
docker compose down -v   # зупинити й видалити дані
```

Compose читає облікові дані й порти з `packages/backend/.env`, тобто з тих самих `PGSQL_*`, `REDIS_*` і `S3_*`, що й backend, тому обидві сторони завжди збігаються. Незадані значення беруть defaults з `.env.example`: `postgres`/`postgres`, Redis без пароля. Якщо задано `REDIS_PASSWORD`, Redis стартує з `requirepass`. `services:up` чекає, доки всі контейнери стануть `healthy`. Порти відкрито лише на `127.0.0.1`: це облікові дані для розробки, а не для спільної мережі.

Якщо порт уже зайнятий (наприклад, локальним PostgreSQL з Homebrew), `services-up` впаде з `bind: address already in use`. `make doctor` заздалегідь показує, який процес тримає порт. Локальний PostgreSQL з pgvector можна використовувати замість контейнера: `make services-up ARGS="redis s3 mailpit"` (`pnpm services:up redis s3 mailpit`). Деталі: [Команди make → Зайняті порти](/reference/make#заиняті-порти-і-свіи-postgresql).

PostgreSQL і Redis працюють без додаткових змінних. Щоб увімкнути завантаження файлів і пошту, додайте в `.env`:

```dotenv
# S3 (SeaweedFS): бакет створюється на старті, ключі — будь-які ваші
S3_ACCESS_KEY_ID=devaccesskey
S3_SECRET_ACCESS_KEY=devsecretkey
S3_BUCKET=vibe-template
S3_ENDPOINT=http://127.0.0.1:8333
S3_REGION=us-east-1
CDN_URL=http://127.0.0.1:8333/vibe-template

# пошта йде в Mailpit
SMTP_ENABLED=true
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_REQUIRE_TLS=false
SMTP_IGNORE_TLS=true
SMTP_FROM_EMAIL=noreply@example.com
```

Анонімне читання в сховищі відкрито лише під `S3_BUCKET/S3_PREFIX/` (за замовчуванням `app/`), бо браузер завантажує аватари й скриншоти напряму з `CDN_URL`. Решта бакета й перелік об'єктів потребують ключа. Як backend працює зі сховищем: [Сховище файлів](/backend/storage).

::: tip Порт уже зайнятий
Якщо на хості вже працюють PostgreSQL чи Redis, задайте в `.env` інші `PGSQL_PORT` / `REDIS_PORT` (наприклад `5433`): compose відкриє контейнер на цьому порту, і backend підключиться туди ж.
:::

::: warning Лише для розробки
Цей compose не призначений для production: облікові дані за замовчуванням відомі всім, а SeaweedFS працює в одно-процесному режимі `mini`. Розгортання описано на сторінці [Розгортання](/backend/deployment).
:::

### Увесь застосунок у Docker Compose

Щоб подивитися на застосунок без Node.js на хості або перевірити саме production-збірку, його можна запустити в compose разом із сервісами. Це той самий образ, що й для production ([`Dockerfile`](https://github.com/Blazheiko/vibe-template/blob/main/Dockerfile)): backend віддає зібраний frontend (`SERVE_STATIC=true`), тому все працює з одного origin `http://localhost:3000`. Hot reload тут немає: після змін у коді образ треба зібрати знову. Для щоденної розробки лишається `pnpm dev`.

```bash
make app-build   # scripts/docker-build.sh: локальний образ vibe-template:local
make app-up      # сервіси + migrate + app, чекає, доки app стане healthy
make app-seed    # за бажанням: довідкові дані й demo-акаунти з SEED_* у .env
make app-logs    # лог застосунку
make app-down    # зупинити лише застосунок, сервіси працюють далі (назад до make dev)
make services-down   # зупинити все
```

Застосунок і міграції описано в compose під профілем `app`, тому `make services-up` їх не запускає.

| Сервіс    | Що робить                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrate` | одноразово виконує `pnpm db:create:prod && pnpm db:migrate` і завершується                                                                  |
| `app`     | `node dist/index.js` на `127.0.0.1:APP_PORT` (3000); стартує після успішного `migrate`. `up --wait` чекає його `HEALTHCHECK` (`/api/ready`) |

[`scripts/docker-build.sh`](https://github.com/Blazheiko/vibe-template/blob/main/scripts/docker-build.sh) збирає образ з тегом `APP_IMAGE` (за замовчуванням `vibe-template:local`) і позначає його git-ревізією. Frontend збирається без Sentry і без `VITE_BASE_URL`, тобто з API на тому ж origin. Додаткові аргументи передаються в `docker build`, наприклад `make app-build ARGS=--no-cache`. Compose образ не збирає і не завантажує (`pull_policy: never`): без `make app-build` `app:up` завершиться помилкою `No such image: vibe-template:local`.

**Змінні.** Контейнери отримують увесь `packages/backend/.env` (`APP_KEY`, ключі AI й OAuth, VAPID, ліміти), але compose перекриває ті значення, які всередині мережі compose мусять бути іншими:

| Що                    | Значення в контейнері                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| адреса застосунку     | `APP_URL`, `FRONTEND_URL`, `LANDING_URL` = `http://localhost:APP_PORT`, `DOMAIN=localhost:APP_PORT`                         |
| режим                 | `APP_ENV=local`, `APP_IS_PRODUCTION=false`, `SERVE_STATIC=true`, `DOC_PAGE=false`                                           |
| префікс API           | `API_PATH_PREFIX`: зі shell, інакше з `packages/backend/.env`, інакше `api`, як і під час `pnpm app:build`                  |
| PostgreSQL, Redis     | `PGSQL_HOST=postgres`, `PGSQL_PORT=5432`, `REDIS_HOST=redis`, `REDIS_PORT=6379`                                             |
| S3                    | `S3_ENDPOINT=http://s3:8333`, ключі й бакет — ті самі, що в сервісу `s3`; `CDN_URL=http://localhost:S3_HOST_PORT/S3_BUCKET` |
| пошта                 | Mailpit: `SMTP_ENABLED=true`, `SMTP_HOST=mailpit`, `SMTP_PORT=1025`, без TLS                                                |
| origin для CSRF і CSP | `CSRF_ALLOWED_ORIGINS`, `CSP_API_ORIGIN`, `CSP_WS_ORIGIN` порожні, тож беруться з `APP_URL` і `DOMAIN`                      |

`APP_ENV=local` потрібен з тієї ж причини, що й у `pnpm prod:local`: це plain http. З `production` cookie сесії мали б прапор `Secure`, WebSocket отримав би `wss://`, а CSP додала б `upgrade-insecure-requests`. Решта, зокрема `CSRF_ENFORCE` і `CSRF_STRICT_ORIGIN`, береться з вашого `.env` без змін.

::: tip Порт 3000 уже зайнятий
`make dev` теж слухає порт 3000. Щоб повернутися до розробки, виконайте `make app-down`: він прибирає контейнери `app` і `migrate`, а сервіси лишає. Щоб запускати обидва одночасно, зупиніть `make dev` або задайте в `.env` інший `APP_PORT`, наприклад `APP_PORT=3001`: тоді застосунок буде на `http://localhost:3001`, і всі адреси в таблиці вище підлаштуються під цей порт.
:::

Перевірено (2026-11-06, Docker Desktop на macOS):

- після `make app-up` усі контейнери `healthy`, `migrate` завершився з кодом 0;
- `/api/ready` повертає `ok`, `/` віддає SPA з CSP, у якій є origin застосунку й `CDN_URL`;
- вхід demo-користувача через CSRF; з `CSRF_ENFORCE=true` чужий origin отримує `403 origin_mismatch`;
- аватар завантажується в SeaweedFS і читається браузером з `CDN_URL`;
- лист скидання пароля з посиланням на `http://localhost:<APP_PORT>` з'являється в Mailpit;
- WebSocket за `ws://localhost:<APP_PORT>/api/websocket` відкривається;
- `make services-up` запускає лише чотири сервіси, `make services-down` зупиняє й застосунок.

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

Команди запускаються з кореня; кожна викликає скрипт workspace backend (`pnpm --filter backend db:*`):

```bash
make db-create    # створює БД і розширення vector
make db-migrate   # drizzle-kit migrate
make db-seed      # початкові промпти; з ARGS=--demo ще й demo-акаунти
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
`db:seed` вставляє початкові AI-промпти й безпечний для повторного запуску. Щоб отримати адміна для локальної роботи, задайте `SEED_ADMIN_EMAIL` і `SEED_ADMIN_PASSWORD` у `.env` (опційно `SEED_USER_*`) і виконайте `make db-seed ARGS=--demo`. Запускайте seed до `make dev`, бо промпти кешуються на старті. Деталі: [База даних → Seed](/backend/database#seed).
:::

Детальніше про схему та міграції: [База даних](/backend/database).

## 4. Запуск

```bash
make dev
```

Ціль викликає `pnpm dev`: скрипт збирає `shared` і `backend`, а потім паралельно запускає dev-сервери backend і frontend ([package.json](https://github.com/Blazheiko/vibe-template/blob/main/package.json)). Обидва dev-сервери читають `shared` із `src/`, тому зміни в `packages/shared/src` підхоплюються без перезбирання (див. [Структура проєкту](/guide/project-structure)). Після старту:

| Сервіс                     | URL                                                                     | Джерело                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Backend (HTTP + WebSocket) | `http://localhost:3000` (`PORT`, `HOST=0.0.0.0`)                        | [config/app.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/app.ts) |
| Frontend (Vite)            | `http://localhost:5173`; `/api` і `/ws` проксюються на `127.0.0.1:3000` | [vite.config.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/vite.config.ts)  |

У лозі backend має з'явитися рядок `Listening http://0.0.0.0:3000`, а у Vite рядок `Local: http://localhost:5173/`.

Пакети можна запускати й окремо: `make dev-backend` / `make dev-frontend` (див. [Команди make](/reference/make)).

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
  -d '{"identifier":"user@example.com","password":"<user-password>","token":""}' $B/auth/login

# 2. хто я: cookie йде автоматично
curl -s -b cookies.txt $B/main/init

# 3. вихід: після входу токен новий, беремо його знову з init
CSRF=$(curl -s -b cookies.txt -c cookies.txt $B/main/init | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')
curl -s -b cookies.txt -c cookies.txt -X POST -H "$O" -H "x-csrf-token: $CSRF" $B/auth/logout

# 4. після виходу: 401
curl -s -o /dev/null -w '%{http_code}\n' -b cookies.txt $B/main/init
```

Тіло входу описує схема [`login.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/auth/login.ts): `identifier` — email або телефон, `token` необов'язковий (фронтенд передає порожній рядок). Невідомі поля схема відхиляє: зі старим полем `email` замість `identifier` сервер відповість `422 validation_failed`.

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
