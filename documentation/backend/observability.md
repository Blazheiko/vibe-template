# Observability

Сторінка описує, як бекенд пише логи, що потрапляє в Sentry, як влаштовані liveness і readiness і чого в шаблоні поки немає (метрики). Змінні оточення Sentry перелічені в [Конфігурації](/backend/configuration), обробка помилок HTTP — у [Життєвому циклі запиту](/backend/request-lifecycle), Sentry-аргументи збірки фронтенду — у [Деплої](/backend/deployment).

## Логування

Логер — [pino](https://getpino.io) 10, єдиний екземпляр експортується з [logger.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/logger.ts) (імпорт `#vendor/utils/logger.js`).

- **Рівень.** `LOG_LEVEL` ([`config/logging.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/logging.ts)): `fatal`, `error`, `warn`, `info` (за замовчуванням), `debug`, `trace` або `silent`, без огляду на регістр. Невідоме значення зупиняє старт (`Invalid logging configuration`).
- **Формат.** Якщо `APP_ENV` дорівнює `prod` або `production`, логи йдуть у stdout як JSON-рядки (`destination({ sync: false })`). В інших оточеннях використовується `pino-pretty` з кольорами; пакет імпортується динамічно лише поза production.
- **Потоки.** `multistream` має два потоки: основний (stdout) і `sentryStream` рівня `error`, який пересилає помилки в Sentry (див. нижче).
- **Серіалізатори.** Додано лише серіалізатор `bigint` → рядок.
- **Redaction.** Опції pino `redact` немає. Маскування робиться вручну: хелпери `maskEmailForLogs` / маскування телефону в [mask-sensitive.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/helpers/mask-sensitive.ts).

::: danger Токени в логах
Оскільки автоматичного redact немає, усе, що передано в об'єкт логу, пишеться як є. Відома проблема №3 у [code-issues-found-during-docs.md](https://github.com/Blazheiko/vibe-template/blob/main/docs/plan/code-issues-found-during-docs.md) — токени потрапляють у логи. Не логуйте `httpData`, заголовки чи тіла запитів цілком.
:::

### Логер запиту

Для кожного HTTP-запиту і WS-повідомлення створюється дочірній логер `logger.child({ requestId })`, де `requestId` — `randomUUID()`. HTTP-`requestId` генерується на першому кроці обробки (`server.ts`), ще до читання тіла, тож його мають і помилки 413/415/422. Коли `session_web` відновив сесію з користувачем, логер запиту замінюється на `child({ userId })`; WS-логер отримує `userId` з даних з'єднання. Він доступний у контролерах як `ctx.logger` ([http-context.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/context/http-context.ts), [ws-context.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/context/ws-context.ts)).

### Що логується при помилці

`handleError` у [server.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/server.ts) пише через `logger.child({ requestId, userId, route, method })` — кожен запис нижче має ці поля (`userId` — коли відомий):

| Помилка                                       | Рівень  | Поля                                                        |
| --------------------------------------------- | ------- | ----------------------------------------------------------- |
| `PayloadTooLargeError`                        | `warn`  | `limit`, `contentType`                                      |
| `MalformedBodyError`                          | `warn`  | `bodyKind` (без тіла запиту й тексту помилки парсера)       |
| `UnsupportedMediaTypeError`                   | `warn`  | `receivedContentType`, `allowedKinds`                       |
| `ValidationError`, `ParameterValidationError` | `warn`  | `err`                                                       |
| `RedisUnavailableError` (відповідь 503)       | `error` | `err` + контекст; у Sentry не йде (див. нижче)              |
| інше (відповідь 500)                          | `error` | `err` + `requestId`, `userId`, `route`, `method` (контекст) |

Для маршрутів API контекст містить `requestId`, `userId`, `route.url`, `route.method`; для службового обробника документації маршрутів — лише `route` і `method`. `userId` береться в момент помилки: для 413/415/422 його немає, бо тіло читається й валідується до middleware сесії. Коди відповідей — у [Життєвому циклі запиту](/backend/request-lifecycle).

### Помилки сервісів (`AppError`)

Сервіси повертають помилки як `Result` і не кидають їх, тож `handleError` їх не бачить. Їх логує контролерний шар: `mapControllerError` і `mapWsControllerError` викликають [`reportAppError`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/shared/report-app-error.ts) через логер запиту. Деталі — у [Контролерах](/backend/controllers#мапінг-помилок).

| `AppError`                                          | Рівень      | Поля                                      | Sentry                              |
| --------------------------------------------------- | ----------- | ----------------------------------------- | ----------------------------------- |
| 4xx (`BadRequest`, `NotFound`, `Conflict` тощо)     | не пишеться | —                                         | ні                                  |
| `Internal`, `UpstreamError`, `UpstreamTimeout`      | `error`     | `err` (першопричина), `appError` (`_tag`) | так                                 |
| `ServiceUnavailable`, причина — недоступність Redis | `error`     | `err`, `appError`, `sentrySkip: true`     | ні, подію дає модуль здоров'я Redis |
| `ServiceUnavailable`, інша причина                  | `error`     | `err`, `appError`                         | так                                 |

Також у [index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/index.ts): `uncaughtException` логується як `error` з `sentrySkip: true` і окремо відправляється через `sentryService.captureException`; при graceful shutdown викликається `sentryService.flush(2000)`.

## Sentry (бекенд)

### Ініціалізація

[sentry-bootstrap.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/sentry-bootstrap.ts) — це перший імпорт у [index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/index.ts): він завантажує `dotenv/config` і викликає `sentryService.init()`. Конфіг — [config/sentry.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/sentry.ts):

- Sentry активний, лише якщо `SENTRY_DSN` непорожній і `SENTRY_ENABLED` не `false`. Інакше всі методи сервісу — no-op.
- В `Sentry.init` передаються `dsn`, `environment` (`SENTRY_ENVIRONMENT` або `APP_ENV`), `release`, `tracesSampleRate` (дефолт `0`). Додаткові `integrations` не задаються — діють стандартні з `@sentry/node` 11.
- Помилка `Sentry.init` не зупиняє застосунок: пишеться `console.warn`, Sentry лишається вимкненим.

```dotenv
SENTRY_DSN=https://<public-key>@<org>.ingest.sentry.io/<project-id>
SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=<git-sha>
SENTRY_TRACES_SAMPLE_RATE=0
```

### PII і санітизація

У Sentry 11 `sendDefaultPii` прибрано, тому [sentry-service.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/observability/sentry-service.ts) явно вимикає збір через `dataCollection`: `userInfo`, `cookies`, `httpBodies: []`, `genAI` inputs/outputs, `databaseQueryData`, `queues`, `stackFrameVariables` — усе `false`.

Додатково event processor `sanitizeEvent`:

- видаляє з `tags`, `extra`, `contexts` ключі, що збігаються з `/token|secret|password|cookie|auth|api[_-]?key|bearer/i`;
- видаляє заголовки `authorization`, `cookie` і ті, що збігаються з тим самим regex;
- видаляє `request.data`, якщо `status_code >= 400`, інакше обрізає його до 10 КБ.

З користувача в Sentry передається лише `id` (`scope.setUser({ id })`).

### Що потрапляє в Sentry

Логи пересилає `sentryStream` у [logger.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/logger.ts). Правила:

1. Рівень нижче `error` (50) ігнорується — `warn` (4xx у `handleError`) у Sentry не йде.
2. `sentrySkip: true` — пропустити (використовується, коли помилку відправлено вручну). Так само пропускаються записи з `err.type === "RedisUnavailableError"`: інцидент уже зафіксовано модулем здоров'я Redis, див. [Відмова Redis](#відмова-redis).
3. Є поле `err` або `error` → `captureException`.
4. Інакше лише при `sentryCapture: true` → `captureMessage(msg, "error")`.

До події додаються теги `requestId`, `route`, `method` і `user.id`, якщо вони є в записі логу. `AppError` (об'єкти з `_tag`) нормалізуються в `Error` з ім'ям `AppError.<tag>`.

```ts
// повідомлення без exception — лише з явним прапорцем
ctx.logger.error({ sentryCapture: true, orderId }, 'Payment webhook mismatch')

// вже відправлено вручну — не дублювати
logger.error({ err, sentrySkip: true }, 'event uncaughtException')
```

```mermaid
flowchart TD
    A[Помилка в обробнику] --> B[handleError]
    B -->|400 невалідне тіло, 413, 415, валідація| C[logger.warn]
    B -->|RedisUnavailableError| U["logger.error, err.type RedisUnavailableError"]
    B -->|інше| D["logger.error з err і контекстом"]
    C --> R1[Відповідь 4xx]
    U --> SU[sentryStream: пропуск за err.type]
    SU --> R3["Відповідь 503 service_unavailable, Retry-After: 1"]
    D --> S[sentryStream]
    S -->|sentrySkip| X[Пропуск]
    S -->|є err| E[captureException]
    E --> R2["Відповідь 500 internal_error"]
    X --> R2
```

### Відмова Redis

Стан основного Redis-клієнта тримає [redis-health.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/redis-health.ts): `healthy` або `unavailable`.

- **Одна подія на інцидент.** Перехід `healthy → unavailable` (перша подія `error`/`close` клієнта або перша `RedisUnavailableError` з `withRedis`) пише один `logger.error({ sentryCapture: true }, "Redis unavailable")` — це єдина подія Sentry за інцидент.
- **Поки інцидент триває**, модуль пише `warn` `"Redis still unavailable"` не частіше разу на хвилину і раз на 2 с шле фоновий `PING`.
- **Відновлення** — за першим із сигналів: успішна команда через `withRedis`, успішний фоновий `PING` або подія `ready` після reconnect. Тоді пишеться `info` `"Redis recovered"` з `downMs`, стан стає `healthy`, і наступний збій знову дасть одну подію.
- **На процес, а не на кластер.** Кожен процес має власний стан, тож N інстансів дадуть N подій; групує їх сам Sentry.
- **Інші записи не дублюють подію.** `sentryStream` пропускає записи, де `err.type === "RedisUnavailableError"` (поле, яке пише серіалізатор pino). Цю обгортку кидає лише основний клієнт. Rate-limit клієнт кидає сирі помилки ioredis (`err.type === "Error"`), тому `reportAppError` сама позначає такі записи `sentrySkip: true`, коли `isRedisUnavailable(cause)`. `isRedisUnavailable` дивиться лише на ознаки, які дає тільки ioredis (`MaxRetriesPerRequestError`, `Command timed out`, `Connection is closed`, `Stream isn't writeable`). Голий код сокета (`ECONNREFUSED` тощо) не рахується: його так само дають S3, PostgreSQL чи SMTP, і такий збій має бути 500 з подією в Sentry. Коди сокета враховує лише `withRedis` основного клієнта (`isRedisCommandUnavailable`), де джерело відоме. Окремого модуля здоров'я в rate-limit клієнта немає: його збій видно лише в stdout (`warn` `"Rate-limit Redis connection error"`).
- **Свідоме рішення щодо stdout.** `logger.error` із `handleError` і з login/logout/`logoutAll` під час збою лишаються в stdout на кожен запит: це діагностика конкретних запитів, і їхній обсяг обмежений самими запитами. Обмеження «раз на хвилину» діє лише для модуля здоров'я. Якщо обсяг логів стане проблемою, наступний крок — понизити ці записи до `warn`, а не прибирати.

### Сервіси observability

У [app/services/observability](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/observability/sentry-service.ts) є лише `sentryService`: `init`, `isEnabled`, `captureException`, `captureMessage`, `withScope`, `flush`. Тести — [sentry-service.spec.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/observability/sentry-service.spec.ts).

## Sentry (фронтенд)

Фронтенд використовує `@sentry/vue` ([sentry-service.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/sentry-service.ts), [sentry-config.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/sentry-config.ts)). Налаштування задаються на етапі збірки через `VITE_SENTRY_DSN`, `VITE_SENTRY_ENABLED`, `VITE_SENTRY_ENVIRONMENT` (дефолт — Vite `MODE`), `VITE_SENTRY_RELEASE`, `VITE_SENTRY_TRACES_SAMPLE_RATE`, `VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE`, `VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE`. Так само, як на бекенді, `dataCollection` вимикає збір PII. Як передати ці значення в Docker-збірку — у [Деплої](/backend/deployment).

## Health check

`GET /api/ping` ([http-routes.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts) → `MainController.ping` у [main-controller.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/controllers/http/core/main-controller.ts) → `mainService.ping` у [main-service.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/core/main-service.ts)) повертає статичне:

```json
{ "status": "ok" }
```

`/api/ping` — **liveness**: підтверджує лише, що процес слухає порт, і нічого не перевіряє.

`GET /api/ready` — **readiness** ([`readiness-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/core/readiness-service.ts)): паралельно `SELECT 1` у PostgreSQL (через `healthRepository`) і `PING` основного Redis, кожна перевірка з таймаутом `READINESS_CHECK_TIMEOUT_MS` (за замовчуванням 1000 мс). Обидві відповіли — `200 { "status": "ok" }`; інакше `503 { "status": "unavailable" }` без деталей, а що саме впало — у `warn` «Readiness check failed» (`failed: ["redis"]` тощо). Маршрут без сесії й CSRF; глобальний ліміт за IP діє, але частота healthcheck на порядки нижча за поріг. S3 і SMTP не перевіряються. На `/ready` налаштований `HEALTHCHECK` Docker-образу (див. [Деплой](/backend/deployment)).

Перевірено наживо: зупинка Redis → `503` за ~0,05 с; зупинка PostgreSQL → `503`, `/ping` далі `ok`; після повернення БД `/ready` знову `200`.

::: tip Обрив з'єднання з PostgreSQL
`pg.Pool` при обриві простою з'єднання (рестарт, failover) емітить `error`. Без обробника Node перетворював це на `uncaughtException`, і сервер зупинявся — знайдено під час feat-030. Тепер [`db.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/db.ts) логує подію (`PostgreSQL pool: idle client error`), пул сам замінює клієнт, а `/ready` відповідає `503`, доки БД недоступна.
:::

## Метрики і трасування

- Prometheus/OpenTelemetry-метрик у бекенді немає: серед залежностей [package.json](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/package.json) є лише `@sentry/node`, `pino`, `pino-pretty`. `@opentelemetry/api` у lockfile — транзитивна залежність, у коді не використовується.
- Трасування можливе лише через Sentry performance: `SENTRY_TRACES_SAMPLE_RATE` > 0 (дефолт `0` — трасування вимкнене).

## Практика

**Читати логи локально.** `pnpm dev:backend` виводить pretty-логи. Щоб знайти всі записи одного запиту, шукайте його `requestId`. У production (`APP_ENV=production`) логи — JSON, їх зручно фільтрувати через `jq`:

```bash
docker logs <container> | jq 'select(.level >= 50)'
docker logs <container> | jq 'select(.requestId == "<uuid>")'
```

**Перевірити Sentry.** Задайте `SENTRY_DSN` і перезапустіть бекенд, потім викличте в коді (наприклад, тимчасово в обробнику локального маршруту) `logger.error({ err: new Error('sentry test') }, 'sentry test')` — запис рівня `error` іде в Sentry. Окремого тестового маршруту немає: мертвий `MainController.testSentryError` видалено (п. 27 у [code-issues-found-during-docs.md](https://github.com/Blazheiko/vibe-template/blob/main/docs/plan/code-issues-found-during-docs.md)).
