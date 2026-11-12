# Як влаштований бекенд

::: info Перед читанням
Нічого знати не потрібно. Буде зручніше, якщо проєкт уже запущено за [Швидким стартом](/guide/getting-started): тоді приклади можна одразу перевірити.
:::

Ця сторінка для тих, хто вперше відкрив шаблон. Тут без зайвих деталей пояснено, з чого складається бекенд, що відбувається з запитом і навіщо код розкладено саме так. Технічні подробиці кожної теми — на окремих сторінках розділу [Бекенд](/backend/), посилання наведено по ходу.

## Коротко

Бекенд — це один Node.js-процес, який:

1. приймає [HTTP-запити](/reference/glossary#http-метод) (`/api/...`) і WebSocket-з'єднання;
2. перевіряє, хто прийшов і чи можна йому це робити;
3. виконує бізнес-логіку, читає й пише дані в PostgreSQL, тримає сесії в Redis;
4. повертає [JSON-відповідь](/reference/glossary#json) або надсилає подію через WebSocket.

Він написаний на [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) — дуже швидкому сервері, написаному на C++. Express, Fastify чи NestJS тут немає: замість них у каталозі `src/vendor/` лежить невелике власне «ядро», яке робить роутинг, читання тіла запиту, сесії, ліміти й логування. Вам не треба його змінювати, щоб додати фічу: увесь ваш код живе в `src/app/`.

::: tip Чому не Express?
uWebSockets.js — один з найшвидших HTTP/WebSocket-серверів для Node.js за [публічними бенчмарками автора](https://github.com/uNetworking/uWebSockets/tree/master/benchmarks). Власних вимірювань для цього шаблону в репозиторії немає, тож реальний виграш залежить від вашого навантаження: якщо більшість часу йде на запити до БД чи AI, швидкість сервера помітна менше. Друга перевага — HTTP і WebSocket працюють в одному процесі. Ціна — у нього немає екосистеми [middleware](/reference/glossary#middleware), як у Express. Шаблон закриває цю прогалину: CORS, CSRF, сесії, rate limiting, валідація та статика вже написані й протестовані.
:::

## Шлях одного запиту

Уявімо, що фронтенд викликає `GET /api/main/init`, щоб дізнатися, хто зараз залогінений.

```mermaid
flowchart TD
  A[Браузер] -->|GET /api/main/init| B[Ядро: пошук маршруту, rate limit]
  B --> V[Валідація query і тіла, якщо маршрут їх описав]
  V -->|невалідні дані| Y[422 Validation failed]
  V --> C[Middleware: session_web, csrf_guard, auth_guard]
  C -->|немає сесії| X[401 Unauthorized]
  C --> D[Controller]
  D --> E[Service: бізнес-логіка]
  E --> F[Repository: SQL через Drizzle]
  F --> G[(PostgreSQL)]
  E --> H[Transformer: прибрати пароль, нормалізувати дати]
  H --> D
  D -->|JSON| A
```

1. **Ядро** знаходить маршрут і перевіряє ліміт запитів (rate limit). Якщо ліміт вичерпано, далі запит не йде.
2. **Валідація.** Якщо маршрут описав схему query-параметрів, ядро їх перевіряє. Для `POST`, `PUT` і `PATCH` ядро ще й читає тіло запиту і перевіряє його за схемою маршруту. У нашого `GET` тіла немає, тому цей крок для нього майже порожній. Некоректні дані отримують `422` ще до middleware і вашого коду.
3. **Middleware** по черзі перевіряють запит: `session_web` піднімає [сесію](/reference/glossary#сесія) з [cookie](/reference/glossary#cookie), `auth_guard` відсікає незалогінених з кодом `401`. `csrf_guard` теж стоїть у ланцюжку, але для `GET` нічого не перевіряє: CSRF-токен потрібен лише для запитів, що змінюють дані (`POST`, `PUT`, `PATCH`, `DELETE`).
4. **Controller** бере дані запиту й викликає потрібний сервіс.
5. **Service** виконує логіку: перевіряє права, рахує, звертається до інших сервісів.
6. **Repository** робить запит до бази.
7. **Transformer** перетворює рядок з бази на безпечний об'єкт для клієнта (без пароля, токенів тощо).
8. Controller повертає результат, ядро серіалізує його в JSON.

::: info Спрощено
Тут опущено частину кроків: CORS-заголовки, перевірку `Content-Type` і розміру тіла, обробку помилок. Повний порядок з посиланнями на код — [Життєвий цикл запиту](/backend/request-lifecycle).
:::

## Навіщо стільки шарів

Новачкам часто здається, що простіше написати все в одному обробнику. На маленькому проєкті це працює, але з ростом такий код стає важко тестувати й змінювати. Шари розділяють відповідальність:

| Шар         | Відповідає за                        | Чого тут **не** має бути      | Де лежить                                    |
| ----------- | ------------------------------------ | ----------------------------- | -------------------------------------------- |
| Route       | URL, метод, схема, middleware, ліміт | Логіки                        | `app/routes/http-routes.ts`, `ws-routes.ts`  |
| Middleware  | Перевірки перед обробником           | Бізнес-правил конкретної фічі | `app/middlewares/`, реєстр у `kernel.ts`     |
| Controller  | «Перекласти» HTTP на виклик сервісу  | SQL, складних обчислень       | `app/controllers/http`, `app/controllers/ws` |
| Service     | Бізнес-логіка, рішення, помилки      | Прямого доступу до таблиць    | `app/services/`                              |
| Repository  | Запити до БД                         | Логування, бізнес-рішень      | `app/repositories/`                          |
| Transformer | Форма даних для клієнта              | Звернень до БД                | `app/transformers/`                          |

Що це дає на практиці:

- **Сервіс можна протестувати без HTTP і без бази** — підмінивши репозиторій.
- **Один сервіс використовують і HTTP, і WebSocket-контролери**, логіка не дублюється.
- **Зміна схеми БД зачіпає лише репозиторій**, а не весь код.
- **Пароль не потрапить у відповідь випадково**, бо дані йдуть клієнту лише через трансформер.

Правила між шарами перевіряє тест [`layering.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/layering.spec.ts): якщо контролер імпортує репозиторій напряму, `pnpm test` впаде. Детальніше — [Архітектура](/backend/architecture).

## Помилки без винятків

Сервіси не кидають `throw` на очікувані помилки («користувача не знайдено», «невірний пароль»). Вони повертають `Result` з бібліотеки `better-result`:

```ts
if (user === null) return Result.err(notFound('User', 'User not found'))
return Result.ok({ user })
```

Контролер перевіряє результат і перетворює помилку на правильний HTTP-статус через `mapControllerError`. Так помилки видно в типах: TypeScript не дасть забути, що виклик може не вдатися. Детальніше — [Контролери → Мапінг помилок](/backend/controllers#мапінг-помилок).

## Звідки беруться типи: єдине джерело істини

У шаблоні типи майже не пишуть вручну. Їх **виводять** з двох описів, кожен з яких — [єдине джерело істини](/reference/glossary#єдине-джерело-істини) для свого контракту:

| Контракт                            | Джерело                                                 | Що з нього виходить                                               |
| ----------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------- |
| API: що клієнт надсилає й отримує   | arktype-схема в `packages/shared`                       | валідатор запиту на бекенді, тип у контролері, тип у фронтенді    |
| База даних: які є таблиці й колонки | Drizzle-схема `packages/backend/src/database/schema.ts` | SQL-міграції, типи рядків `UserRow` / `UserInsert` у репозиторіях |

```mermaid
flowchart LR
  S[arktype-схема в shared] --> V[валідатор маршруту: 422]
  S --> BT[тип у контролері бекенду]
  S --> FT[тип у фронтенді: api.ts, компоненти]
  D[Drizzle schema.ts] --> M[міграції]
  D --> R[UserRow у репозиторії]
  R --> T[transformer]
  T --> BT
```

### API: одна схема — і перевірка, і тип

Ось схема логіну з [`shared/src/schemas/auth/login.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/auth/login.ts):

```ts
export const LoginInputSchema = type({
    identifier: 'string >= 3 & string <= 255',
    password: PasswordSchema,
    '+': 'reject', // невідомі поля відхиляються
})

export type LoginInput = typeof LoginInputSchema.infer // тип виведено зі схеми
```

Межі пароля задає `PasswordSchema` з [`password.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/auth/password.ts): її будують з `PASSWORD_MIN_LENGTH` і `PASSWORD_MAX_LENGTH` з `shared/limits`, тих самих чисел, що перевіряє фронтенд, і всі поля пароля в auth-схемах використовують її.

Цей один файл використовують три місця:

- **маршрут** `POST /api/auth/login` перевіряє тіло запиту: `body: LoginInputSchema` у записі реєстру [`contract-schemas/auth.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/contract-schemas/auth.ts) для контракту `authContracts.login`, а контракт сам звірений з типом схеми;
- **контролер** отримує вже типізовані дані: `login(context: HttpContext<LoginInput>)`;
- **фронтенд** надсилає запит того самого типу: `login: (body: LoginInput) => callApi(authContracts.login, { body }, …)` у [`api.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/api.ts).

Що це дає: перейменуйте в схемі `identifier` на `login`, перезберіть `shared` і запустіть `pnpm typecheck`. Помилки з'являться з обох боків одразу (вивід скорочено):

```text
packages/frontend typecheck: src/components/AuthModals.vue(222,13): error TS2353:
  Object literal may only specify known properties, and 'identifier' does not exist in type ...
packages/backend typecheck: src/app/services/auth/auth-service.ts(88,67): error TS2339:
  Property 'email' does not exist on type ...
```

Без спільної схеми фронтенд і далі надсилав би `identifier`, сервер відповідав би `422`, і помилку знайшли б лише вручну.

### База даних: типи рядків зі схеми Drizzle

Таблиця описана один раз у TypeScript:

```ts
// packages/backend/src/database/schema.ts
export const users = pgTable('users', {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    email: varchar('email', { length: 255 }),
    // ...
})
```

З неї `db:generate` генерує SQL-міграцію, а репозиторій виводить типи рядка ([`user-repository.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/repositories/user/user-repository.ts)):

```ts
export type UserRow = InferSelectModel<typeof users> // те, що повертає SELECT
export type UserInsert = InferInsertModel<typeof users> // те, що можна передати в INSERT
```

Далі тип іде ланцюжком: [`user-transformer.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/transformers/user-transformer.ts) описує публічну форму як `Omit<UserRow, 'password' | 'sessionToken' | ...>`. Додали колонку в `schema.ts` — вона з'явиться в `UserRow` і в серіалізованому користувачі без жодного ручного типу. А пароль туди не потрапить, бо його явно виключено.

### Чого цей підхід не робить

- **API і БД — різні контракти, і це навмисно.** Тип відповіді не виводиться з таблиці автоматично: між ними стоїть transformer, який прибирає секрети і перетворює дати та `bigint` на рядки.
- **Захист працює там, де тип справді імпортовано.** Якщо компонент оголосить власний тип замість імпорту зі `shared`, зміну схеми TypeScript у ньому не помітить. Виняток у самому `shared` один: у `CanonicalErrorResponse` поле `details` має точніший TypeScript-тип, ніж може описати схема ([error-response.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/responses/error-response.ts)).
- **Перевірка відповіді під час виконання залежить від режиму.** Крім TypeScript під час компіляції, сервер перевіряє відповідь кожного маршруту за його схемою відповіді (`ResponseSchema`; для HTTP — `response` запису реєстру). Поза production діє `strict`: розбіжність зі схемою або зайве поле дає `500`. У production за замовчуванням діє `log`: зайві поля вирізаються з попередженням у лозі, розбіжність зі схемою все одно дає `500`. Вимкнути перевірку не можна; маршрут без `ResponseSchema` не перевіряється. Див. [Перевірка відповідей](/backend/response-validation).

Детальніше — [Валідація](/backend/validation), [Пакет shared](/shared/), [База даних](/backend/database).

## Де зберігаються дані

| Сховище         | Що там                                               | Сторінка                                   |
| --------------- | ---------------------------------------------------- | ------------------------------------------ |
| PostgreSQL      | Користувачі, push-підписки, база знань, промпти тощо | [База даних](/backend/database)            |
| Redis           | Сесії, спільні rate limits, тимчасові коди           | [Автентифікація](/backend/auth)            |
| S3 / MinIO      | Файли: аватари, скриншоти                            | [Сховище файлів](/backend/storage)         |
| Пам'ять процесу | Активні WebSocket-з'єднання, кеш статики             | [Кешування та ETag](/backend/caching-etag) |

Схема БД описана в коді через Drizzle [ORM](/reference/glossary#orm) (`src/database/schema.ts`), а зміни схеми застосовуються [міграціями](/reference/glossary#міграція).

## Як працюють сесії

Після логіну сервер створює сесію в Redis і ставить браузеру HttpOnly-cookie з підписаним ідентифікатором. JavaScript на сторінці цю cookie прочитати не може, тож XSS-скрипт не вкраде її і не використає сесію з іншого комп'ютера. Але HttpOnly не робить XSS безпечним: шкідливий скрипт, що виконується на вашій сторінці, все одно може надсилати запити від імені користувача, поки той на сайті. Тому шаблон додатково обмежує, які скрипти можуть виконуватися, через Content-Security-Policy ([CSP](/backend/security#content-security-policy)). На кожен запит middleware `session_web` знаходить сесію в Redis. Вихід — це просто видалення сесії з Redis, тому `logout-all` миттєво розлогінює всі пристрої. Для запитів, що змінюють дані, фронтенд додатково надсилає CSRF-токен у заголовку `x-csrf-token`; токен він отримує з `/api/main/init`. Запит без правильного токена або з чужого сайту сервер відхиляє з `403` — навіщо це і як працює, пояснено на сторінці [CSRF простими словами](/guide/csrf). Детальніше — [Автентифікація](/backend/auth) і [Безпека](/backend/security).

## WebSocket простими словами

HTTP — це «запитав і отримав відповідь». WebSocket — постійне з'єднання, через яке сервер сам може надіслати повідомлення: «новий користувач онлайн», «ось наступний шматок відповіді AI». Фронтенд отримує короткоживучий токен з `/api/main/init`, відкриває з'єднання, і далі обидві сторони обмінюються JSON-повідомленнями. WS-маршрути описуються так само, як HTTP: URL-подія, обробник, схема. Детальніше — [WebSocket](/backend/websocket).

## Конфігурація

Усі налаштування — змінні оточення у файлі `packages/backend/.env` (зразок — `.env.example`). Під час старту `validateRuntimeConfig()` перевіряє, що конфігурація безпечна. Наприклад, сервер не запуститься, якщо секрет для хешування OTP-кодів коротший за 32 символи. Повний довідник — [Конфігурація](/backend/configuration).

## Що робити далі

1. Якщо ще не запускали проєкт, пройдіть [Швидкий старт](/guide/getting-started) разом з першим сценарієм.
2. Відкрийте [`http-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts) і пройдіть по `GET /api/main/init` від маршруту до репозиторію — це найкращий спосіб відчути структуру.
3. Тримайте під рукою [Глосарій](/reference/glossary), якщо зустрінете незнайомий термін.

::: tip Наступний крок
[Від HTTP-запиту до контролера](/guide/http-request): з чого складається запит і як кожне його поле потрапляє в `context` контролера.
:::
