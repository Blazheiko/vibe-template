# Глосарій

Терміни, які трапляються в коді та в цій документації. Назви термінів залишено англійською, як у коді. Основу взято з [`docs/reference/template-glossary.md`](https://github.com/Blazheiko/vibe-template/blob/main/docs/reference/template-glossary.md); кожне визначення звірено з кодом і доповнено термінами з інших сторінок сайту.

Сторінка має дві частини. **Базові поняття** пояснюють загальні терміни веброзробки простою мовою, з прикладами з шаблону. **Терміни шаблону** описують назви з коду цього репозиторію.

## Базові поняття

### Endpoint

Адреса на сервері, за якою можна щось зробити: отримати дані, створити запис. Складається з HTTP-методу і шляху, наприклад `GET /api/main/init`. У коді шаблону endpoint оголошується як маршрут через `defineRoute({ contract, handler })` з контрактом у `shared/contracts` (див. [Перший маршрут](/guide/first-endpoint)).

### HTTP-метод

Дієслово запиту, що каже серверу, яку дію виконати. `GET` — прочитати, `POST` — створити або виконати дію, `PUT`/`PATCH` — змінити, `DELETE` — видалити. У шаблоні від методу залежить, чи читається тіло запиту (лише `POST`, `PUT`, `PATCH`) і чи потрібен CSRF-токен (`POST`, `PUT`, `PATCH`, `DELETE`).

### Статус-код

Тризначне число у відповіді, яке коротко каже, чим закінчився запит. `200` — успіх, `401` — ви не увійшли, `403` — заборонено, `404` — не знайдено, `422` — дані не пройшли перевірку, `500` — помилка на сервері. Відповіді з помилкою в шаблоні також мають поле `code`, наприклад `"code":"validation_failed"`.

### JSON

Текстовий формат даних, з яким працює API шаблону: `{"status":"ok","message":"Hello, world!"}`. І запити з тілом, і відповіді передаються в JSON.

### Header (заголовок)

Додаткова інформація до запиту чи відповіді у форматі `назва: значення`. Наприклад, `content-type: application/json` каже, що тіло — JSON, а `x-csrf-token` несе CSRF-токен. Заголовки відповіді шаблону також вмикають захист у браузері (`content-security-policy`, `x-frame-options`).

### Cookie

Невеликий запис, який сервер просить браузер зберегти (заголовок `Set-Cookie`) і який браузер потім сам додає до кожного запиту на цей сайт. У шаблоні cookie `uapi` містить підписаний ідентифікатор сесії. Вона має прапорець `HttpOnly`, тож JavaScript на сторінці її не бачить.

### CSRF

Cross-Site Request Forgery, «підробка міжсайтового запиту»: чужий сайт змушує браузер надіслати на ваш сайт запит, що змінює дані, і браузер сам додає до нього cookie сесії. Шаблон захищається від цього `SameSite`-cookie, перевірками `Sec-Fetch-Site` і `Origin` та CSRF-токеном у заголовку `x-csrf-token`. Простими словами — [CSRF простими словами](/guide/csrf).

### Payload / тіло запиту

Дані, які клієнт надсилає разом із запитом, зазвичай у JSON: `{"title":"Купити молоко"}`. У `GET` тіла немає, параметри передаються в query.

### Query-параметри

Частина адреси після `?`: у `/api/hello?name=Olena` параметр `name` дорівнює `Olena`. Маршрут описує допустимі параметри через `queryValidator`.

### Сесія

Спосіб «пам'ятати» користувача між запитами. Після входу сервер створює запис у Redis і дає браузеру cookie з його ідентифікатором. Кожен наступний запит з цією cookie сервер упізнає як ваш. Вихід видаляє запис, і cookie більше нічого не відкриває.

### Автентифікація і авторизація

**Автентифікація** відповідає на питання «хто ви?»: вхід за паролем, SMS-кодом або через Google. **Авторизація** — «що вам можна?»: наприклад, адмінка доступна лише ролі `admin`. У шаблоні першу перевіряє middleware `auth_guard` (є сесія з користувачем), другу — `admin_guard` (роль адміна).

### Middleware

Функція, яка виконується перед вашим обробником і може зупинити запит. Як охоронець на вході: перевірив сесію або CSRF-токен і або пропустив далі, або відповів помилкою. У маршрутах шаблону middleware перелічені за назвою: `['session_web', 'csrf_guard', 'auth_guard']`.

### Runtime-валідація

Перевірка даних під час роботи програми. TypeScript перевіряє типи лише під час компіляції, а дані від клієнта приходять пізніше і можуть бути будь-якими. Тому вхідні дані перевіряються схемою arktype при кожному запиті. Некоректний запит отримує `422` і не доходить до вашого коду (див. [Валідація](/backend/validation)).

### Єдине джерело істини

Принцип: кожен факт про систему описано в одному місці, а все інше з нього виводиться. У шаблоні контракт API — це arktype-схема в `shared`, а структура БД — Drizzle-схема в `schema.ts`. Якщо змінити опис, зміниться і перевірка, і тип, тож копії не розходяться (див. [Звідки беруться типи](/guide/how-backend-works#звідки-беруться-типи-єдине-джерело-істини)).

### Виведення типів

Коли TypeScript-тип не пишуть вручну, а отримують з іншого опису. `typeof LoginInputSchema.infer` дає тип зі схеми arktype, `InferSelectModel<typeof users>` — тип рядка з таблиці Drizzle.

### ORM

Бібліотека, яка дає працювати з базою даних через код мови програмування замість ручного SQL. Шаблон використовує Drizzle ORM: таблиці описано в TypeScript, а запити на кшталт `db.select().from(notes)` типізовані.

### Міграція

Файл зі змінами структури бази даних (створити таблицю, додати колонку), який застосовується один раз і по порядку. У шаблоні міграції генерує `pnpm --filter backend db:generate` зі змін у `schema.ts`, а застосовує `db:migrate`. Так база на кожній машині має однакову структуру.

### WebSocket

Постійне з'єднання між браузером і сервером, через яке обидві сторони можуть надсилати повідомлення будь-коли. На відміну від HTTP («запитав — отримав відповідь»), сервер сам повідомляє клієнту про події: новий користувач онлайн, частина відповіді AI. Див. [WebSocket](/backend/websocket).

## Терміни шаблону

| Термін                      | Значення                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Де докладніше                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| API playground              | Vue-застосунок для розробників і QA ([`packages/api-playground`](https://github.com/Blazheiko/vibe-template/blob/main/packages/api-playground)). Він завантажує опис маршрутів з `GET /api/doc/routes` і дає вручну викликати HTTP- і WS-маршрути. Працює лише в manual-test mode                                                                                                                                                                                        | [API Playground](/playground/), [Маршрутизація](/backend/routing)         |
| AppResult                   | `AppResult<T> = ResultType<T, AppError>` з [`services/shared/errors.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/shared/errors.ts). Це результат сервісу, який замість винятку несе або значення, або типізовану помилку. Контролер мапить її в HTTP-статус                                                                                                                                                               | [Сервіси](/backend/services)                                              |
| Branded type                | Тип-примітив із фантомною міткою, що розрізняє семантично різні значення. Приклад: `UserId = string & { readonly [__userIdBrand]: true }` у [`normalize-user-id.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/helpers/normalize-user-id.ts)                                                                                                                                                                                | [Shared](/shared/)                                                        |
| CSRF                        | Cross-site request forgery. Захист підключається middleware `csrf_guard` для небезпечних методів (`post`, `put`, `patch`, `delete`) за наявності сесії. За замовчуванням `CSRF_ENFORCE=false`, тобто порушення лише логуються                                                                                                                                                                                                                                            | [Автентифікація та безпека](/backend/security#csrf)                       |
| Synchronizer-token CSRF     | Модель CSRF, у якій сервер зберігає `csrfToken` (32 байти, base64url) у сесії, а клієнт надсилає його в заголовку `x-csrf-token`. Порівняння виконується через `timingSafeEqual` ([`csrf-guard.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/middlewares/csrf-guard.ts))                                                                                                                                                            | [Автентифікація та безпека](/backend/security#csrf)                       |
| defineRoute / defineWsRoute | Хелпери оголошення HTTP- і WS-маршрутів: `defineRoute` бере контракт (метод, шлях) і схеми з реєстру контрактів, `defineWsRoute` — схеми запиту/відповіді напряму; обидва з `handler` та описом ([`http-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts))                                                                                                                                                | [Маршрутизація](/backend/routing)                                         |
| Embedding                   | Векторне представлення тексту для пошуку в базі знань. Колонка `embedding` має тип `vector(1536)` у [`schema.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/schema.ts)                                                                                                                                                                                                                                                          | [AI](/backend/ai), [База даних](/backend/database)                        |
| ETag                        | Валідатор кешу для статики, яку віддає сервер. Відповідь `304` повертається, коли збігається `If-None-Match`                                                                                                                                                                                                                                                                                                                                                             | [Кешування та ETag](/backend/caching-etag#etag)                           |
| Knowledge base              | Статті підтримки, якими керує адмін (маршрути `/admin/knowledge-base*`). Вони використовуються в support AI для пошуку за embedding                                                                                                                                                                                                                                                                                                                                      | [AI](/backend/ai#support-ai-і-база-знань)                                 |
| Manual-test mode            | Режим `APP_ENV=manual-test`. Разом з `DOC_PAGE=true` і `SERVE_STATIC=true` вмикає ендпоінт `/doc/routes` для API playground ([`server.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/server.ts)). Запускається через `pnpm dev:manual_test`                                                                                                                                                                                 | [Маршрутизація](/backend/routing#інтроспекція-маршрутів-і-api-playground) |
| Middleware                  | Функція `(context, next)` у ланцюжку маршруту: `session_web`, `csrf_guard`, `auth_guard`, `admin_guard` та ін.                                                                                                                                                                                                                                                                                                                                                           | [Маршрутизація](/backend/middlewares)                                     |
| pgvector                    | Розширення PostgreSQL `vector`, потрібне для колонки embedding. `db:create` виконує `CREATE EXTENSION IF NOT EXISTS vector`                                                                                                                                                                                                                                                                                                                                              | [База даних](/backend/database)                                           |
| Presence                    | Облік автентифікованих користувачів, підключених через WebSocket. [`ws-presence-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/communication/ws-presence-service.ts) на connect/disconnect оновлює онлайн-стан і розсилає події `admin_user_online_upsert` / `admin_user_online_remove` в адмін-канал                                                                                                               | [WebSocket](/backend/websocket)                                           |
| Production-like mode        | `appConfig.isProductionLike`: `APP_IS_PRODUCTION`, а якщо її не задано, то `APP_ENV`/`NODE_ENV` зі значенням `production`/`prod`. Вмикає `__Host-`-cookie і забороняє fake SMS                                                                                                                                                                                                                                                                                           | [Конфігурація](/backend/configuration#production-like-режим)              |
| Промпти (retained prompt)   | Збережені системні промпти AI, які адмін редагує і тестує (маршрути `/prompts`). У бекенді терміна «retained prompt» немає (фраза «retained support prompts» є лише в тексті [`AiPolicy.vue`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/views/AiPolicy.vue)): у коді це таблиця `llm_system_prompts` (`llmSystemPrompts` у [`schema.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/schema.ts)) | [AI](/backend/ai#промпти)                                                 |
| Repository                  | Шар доступу до БД через Drizzle, наприклад [`user-repository.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/repositories/user/user-repository.ts). Сервіси працюють з таблицями через репозиторії                                                                                                                                                                                                                                    | [Репозиторії](/backend/repositories)                                      |
| Session                     | Стан автентифікованого браузера в Redis. Клієнт тримає його ідентифікатор у HTTP-only cookie ([`config/session.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/session.ts)). Middleware `session_web`                                                                                                                                                                                                                              | [Автентифікація та безпека](/backend/auth#сесіі)                          |
| Support chat                | Чат користувача з AI-агентом підтримки через WebSocket (WS-маршрути `support_open_chat`, `support_chat`) та HTTP-історія `/support/chat/history`                                                                                                                                                                                                                                                                                                                         | [AI](/backend/ai), [WebSocket](/backend/websocket)                        |
| Transformer                 | Функція серіалізації рядка БД у публічну форму. Наприклад, [`user-transformer.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/transformers/user-transformer.ts) прибирає `password` і `sessionToken`, а `id` і дати перетворює на рядки                                                                                                                                                                                               | [Трансформери](/backend/transformers)                                     |
| VAPID                       | Пара ключів, що ідентифікує сервер для Web Push. Публічний ключ віддається на `GET /push-subscriptions/vapid-public-key`                                                                                                                                                                                                                                                                                                                                                 | [Web Push](/backend/web-push-notification#що-таке-vapid-ключі)            |
| WebSocket token             | Токен, який повертають `/main/init` та `/main/update-ws-token` (обидва під `auth_guard`). Його зберігають у Redis на 60 с ([`generate-ws-token-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/generate-ws-token-service.ts)), і фронтенд передає його при WS upgrade                                                                                                                                           | [WebSocket](/backend/websocket#отримання-токена-по-http)                  |
