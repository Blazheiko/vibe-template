# Життєвий цикл запиту

Ця сторінка простежує шлях HTTP-запиту та WebSocket-з'єднання від старту процесу до відправки відповіді. Усе описане нижче реалізовано у `packages/backend/src/vendor/`; посилання ведуть на актуальний код.

## Старт сервера

[index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/index.ts) у функції `start()`:

1. `validateRuntimeConfig()` — перевірка конфігурації (див. [/backend/configuration](/backend/configuration));
2. `promptService.load()`;
3. `routesHandler(httpRoutes)` і `routesHandler(wsRoutes)` з [router.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/router.ts) розгортають групи у плоский список `RouteItem` (префікс `appConfig.pathPrefix`, злиття `middlewares`, успадкування `rateLimit`, витяг `:param` у `parametersKey`);
4. `createWsRoutesByUrl` будує таблицю WS-маршрутів (лише точний збіг URL, без `:param`);
5. `initServer(...)` з [server.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/server.ts) викликає `configureWebsockets`, `configureHttp` і `listen` (або `listen_unix`, якщо задано `unixPath`). Токен прослуховування зберігається в `state.listenSocket`.

Сигнали `SIGINT`/`SIGHUP`/`SIGTERM` запускають `stopGracefully`: `stopServer` (закриття всіх WS і listen-сокета), `sentryService.flush`, закриття пулу БД і Redis.

## Реєстрація HTTP-обробників

`configureHttp` реєструє: кеш статики (якщо `serveStatic`), кожен маршрут через `registerHttpRoute` (`server.get/post/put/patch/del`), і catch-all `server.any("/*")`, який:

- для `OPTIONS` при `corsConfig.enabled` відповідає `200` з CORS-заголовками (preflight);
- для невідомого шляху під `/<pathPrefix>/` повертає `404` `{ status: "error", code: "not_found", message: "Route not found" }`;
- для інших `GET` віддає статику (`staticHandler`), інакше — `404`.

`setCorsHeader` завжди пише `Vary: Origin`, а `Access-Control-Allow-*` — лише якщо `Origin` є в `corsConfig.allowedOrigins`.

## Обробка HTTP-запиту (setHttpHandler)

```mermaid
sequenceDiagram
  participant Client
  participant UWS as "uWS route handler"
  participant H as "setHttpHandler"
  participant RL as "checkGlobalRateLimit + checkRateLimit"
  participant B as "readAndParseBody"
  participant MW as "executeMiddlewares"
  participant Ctl as "route.handler"
  Client->>UWS: HTTP request
  UWS->>H: res, req, route
  H->>H: res.onAborted, collectRequestMetadata (sync)
  H->>RL: ip, route (L1, then route limit)
  alt rate limit exceeded
    RL-->>Client: sendResponse (status from responseData)
  end
  H->>H: validateQuery
  H->>B: content-type check, limit, Content-Length check
  B->>B: readData (onData, stream limit), parse, validate
  H->>MW: context
  MW->>Ctl: next() chain
  Ctl-->>H: payload
  H-->>Client: sendResponse (JSON)
  Note over H,Client: any throw goes to handleError
```

Кроки у [server.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/server.ts):

1. **Відмова під час зупинки.** Якщо `state.listenSocket === undefined`, з'єднання закривається (`res.close()`).
2. **onAborted.** Реєструється один раз; прапорець передається в `readData` через об'єкт `RequestAbortSignal`, бо в uWS `onAborted` — один слот. Після abort відповідь не пишеться.
3. **Метадані синхронно.** `collectRequestMetadata` до першого `await` збирає cookies (`parseCookies`), query, заголовки (`getHeaders`, без `cookie`, з валідацією `validateHeader`), параметри маршруту (`extractParameters` з `validateParameter`), IP (`getIP`), `content-type` і `bodyKind`. `hasBody` дорівнює `true` для `post`, `put` і `patch` (`BODY_METHODS` у [body-methods.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/routing/body-methods.ts)); для `get` і `delete` тіло не читається.
4. **Rate limit до читання тіла.** Спершу `checkGlobalRateLimit` (L1: один бюджет на IP для всіх API-запитів, за замовчуванням 600 на хвилину), потім `checkRateLimit` ([http-rate-limit.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/rate-limit/http-rate-limit.ts)): ліміт маршруту, інакше групи, без ліміту — пропускає. Обидві перевірки синхронні, щоб не пропустити `onData`. API-404, preflight `OPTIONS` і `/<pathPrefix>/doc/routes` не проходять через `setHttpHandler`, але L1 для них викликається окремо. Деталі — [Обмеження частоти запитів](/backend/security#обмеження-частоти-запитів).
5. **Query.** `validateQuery` валідує query лише якщо в маршруті є `queryValidator`, інакше `httpData.query === null`.
6. **Тіло.** `readAndParseBody` (деталі нижче).
7. **Контекст і middleware.** Формується `HttpData`, `contextHandler` створює контекст; `executeMiddlewares` ([execute-httpMiddlewares.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/middlewares/core/execute-httpMiddlewares.ts)) виконує ланцюжок. Handler викликається, лише якщо всі middleware викликали `next()` і `responseData.status` у діапазоні 2xx. Після handler (і перед відправкою) сервер викликає `context.session.beforeSend`, якщо сесійний шар його задав: так відповідь не повертає cookie сесії, яку тим часом видалив інший запит (див. [Автентифікація](/backend/auth#redis-як-джерело-істини)).
8. **Відповідь.** `sendResponse` пише статус, `content-type: application/json` (лише коли є тіло), security-заголовки, заголовки й cookies з `responseData`, CORS; тіло — `makeJson(payload)`. Відповіді з порожнім payload — у розділі [Відповідь без даних](#відповідь-без-даних).

## Тіло запиту: типи і ліміти

`detectBodyKind` у [http-request-handlers.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/network/http-request-handlers.ts):

| Content-Type                                              | BodyKind                        | Ліміт (config/app.ts)    | Env                           | За замовчуванням |
| --------------------------------------------------------- | ------------------------------- | ------------------------ | ----------------------------- | ---------------- |
| `/^application\/json\s*(;\|$)/i`                          | `json`                          | `maxJsonBodySize`        | `APP_MAX_JSON_BODY_SIZE`      | 2 097 152        |
| `multipart/form-data…`                                    | `multipart`                     | `maxMultipartBodySize`   | `APP_MAX_MULTIPART_BODY_SIZE` | 52 428 800       |
| `application/octet-stream…`                               | `octet`                         | `maxOctetStreamBodySize` | `APP_MAX_OCTET_BODY_SIZE`     | 52 428 800       |
| `application/x-www-form-urlencoded…`, `text/plain…`, інше | `urlencoded` / `text` / `other` | `maxBodySize`            | `APP_MAX_BODY_SIZE`           | 2 097 152        |

Значення читаються через `parseSize` у [config/app.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/app.ts): лише додатне безпечне ціле число байт, інакше default (див. [Конфігурація](/backend/configuration#ліміти-тіла-запиту)). Ліміти маршрутів видно в playground (`bodyLimits`). JSON визначається регулярним виразом, тож `application/json; charset=utf-8` — це `json`, а `application/json-patch+json` — `other`.

Порядок у `readAndParseBody`:

1. Метод без тіла (`hasBody === false`) — тіло не читається, `payload = null`.
2. Немає `Content-Type`:
    - маршрут без `validator` — тіло не читається, `payload = null`;
    - маршрут з `validator`, є framing тіла (`Transfer-Encoding` або `Content-Length` не нуль; `0`, `00` тощо означають нуль байтів, [RFC 9110 §8.6](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.6), а некоректне значення вважається тілом) — `UnsupportedMediaTypeError` з `receivedContentType: null` → **415** до читання тіла;
    - маршрут з `validator`, framing немає — тіло вважається порожнім і валідується як `{}` (так само, як порожнє JSON-тіло): обов'язкові поля → **422**, defaults схеми застосовуються.
3. `bodyKind` має бути в `route.allowedContentTypes` (за замовчуванням `["json"]`), інакше `UnsupportedMediaTypeError` → **415**. Наприклад, завантаження аватара оголошує `allowedContentTypes: ["multipart"]`.
4. Ранній відказ: якщо `Content-Length` — ціле число і більше ліміту, кидається `PayloadTooLargeError` → **413** без читання тіла. Пробіли навколо значення вже прибрав `getHeaders`. `Content-Length`, рівний ліміту, рано не відхиляється.
5. `readData` збирає чанки з `res.onData` і перериває читання з `PayloadTooLargeError`, щойно сума **перевищить** ліміт: тіло рівно в ліміт байтів проходить, ліміт + 1 — ні. Рахуються байти, не символи, і багатобайтовий UTF-8 символ може бути розрізаний між чанками. Це захищає від chunked-тіл і неправдивого `Content-Length`. На справжньому uWS клієнт отримує повну відповідь 413, не дочекавшись кінця свого тіла: і коли надіслано лише заголовки із завеликим `Content-Length`, і коли ліміт перевищено на неостанньому chunked-чанку ([http-body-limits.transport.spec.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/http-body-limits.transport.spec.ts)).
6. Парсинг: `json` → `JSON.parse` (тільки об'єкт, порожнє тіло → `{}`; невалідний JSON або не-об'єкт → `MalformedBodyError`, без уривка тіла в повідомленні), `multipart` → `getParts` з uWS (поля в payload, файли в `files`), `urlencoded` → `URLSearchParams`, `text` → рядок, `octet` → один файл (ім'я з `content-disposition` або `x-filename`).
7. Якщо є `route.validator` і payload — `validateRoutePayload`. Якщо валідатора немає, `payload` стає `null` (файли зберігаються). Парсер `octet` завжди повертає `payload: null` і файл у `files`, тому `validator` на `octet`-маршруті не викликається: контракт бінарних upload-маршрутів поки не визначено.

### Запит без `Content-Type`

Поведінка з кроку 2 — контракт API цього шаблону. RFC його не вимагає: за [RFC 9110 §8.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.3) отримувач без `Content-Type` може вгадати тип або вважати вміст `application/octet-stream`. Шаблон обирає явну відмову, щоб не читати вміст невідомого типу і щоб маршрут з `validator` ніколи не отримав `payload = null`.

`Transfer-Encoding` вважається framing тіла, навіть якщо chunked-тіло виявиться порожнім ([RFC 9112 §6.3](https://www.rfc-editor.org/rfc/rfc9112.html#section-6.3)): рішення приймається до читання, тому порожній chunked-запит без `Content-Type` теж отримує 415.

| Запит до маршруту з `validator`                  | Відповідь                                      |
| ------------------------------------------------ | ---------------------------------------------- |
| без `Content-Type` і без тіла                    | валідація `{}`: 422 зі списком полів або успіх |
| без `Content-Type`, з `Content-Length > 0`       | 415, `details.receivedContentType: null`       |
| без `Content-Type`, `Transfer-Encoding: chunked` | 415, навіть якщо байтів немає                  |

Перевірити через `curl` (для запиту з тілом `-H 'Content-Type:'` прибирає заголовок, який `curl` сам додає до `-d`):

```bash
curl -X POST http://127.0.0.1:3000/api/auth/login                                              # 422
curl -X POST -H 'Content-Type:' -d '{"email":"a@b.c"}' http://127.0.0.1:3000/api/auth/login   # 415
```

## Відповідь без даних

Порожній payload — це лише `null` або `undefined`, які повернув handler; `false`, `0` і `""` — дані й серіалізуються в JSON. Правила `sendResponse` ([server.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/server.ts)):

| Ситуація                                   | Відповідь                                                |
| ------------------------------------------ | -------------------------------------------------------- |
| 3xx (включно з 304)                        | без тіла                                                 |
| статус 204 або 205                         | без тіла, навіть якщо payload є                          |
| 200 і порожній payload                     | **204 No Content**, без тіла                             |
| інший 2xx (201, 202, …) і порожній payload | той самий статус, без тіла                               |
| 4xx/5xx і порожній payload                 | `{ status: "error", code, message }`, `application/json` |
| інакше                                     | `makeJson(payload)`, `application/json`                  |

У відповіді без тіла немає `Content-Type`: `sendResponse` його не пише і пропускає `Content-Type` і `Content-Length` з `responseData.headers` (назва без урахування регістру), бо framing такої відповіді задає uWS. Інші заголовки, cookies, security-заголовки й CORS пишуться як завжди, тож дія без даних може ставити cookie у 204. 204 і 304 завершуються через `res.endWithoutBody()`, бо `res.end()` у uWS додає `Content-Length: 0`, а в 204 цього заголовка бути не може ([RFC 9110 §8.6](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.6)); решта відповідей без тіла йде з `Content-Length: 0`. Статуси без тіла — за [RFC 9110 §15.3.5](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.5), [§15.3.6](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.6), [§15.4.5](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.4.5).

`code` для 4xx/5xx береться зі спільного `ErrorCode` (`shared/errors`) за таблицею в `buildStatusErrorBody` ([http-response-handlers.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/network/http-response-handlers.ts)): 400 `bad_request`, 401 `unauthorized`, 403 `forbidden`, 404 `not_found`, 409 `conflict`, 413 `payload_too_large`, 415 `unsupported_media_type`, 422 `validation_failed`, 429 `rate_limited`, 502 `upstream_error`, 503 `service_unavailable`, 504 `upstream_timeout`; інший 4xx — `bad_request`, інший 5xx — `internal_error`. `message` — reason phrase статусу з `node:http`, а без неї — `"Error"`. Middleware і `applyAppErrorStatus` ставлять payload самі, тож це правило — запасне для handler'а, що поставив статус помилки без тіла.

## Обробка помилок (handleError)

| Помилка                               | Статус             | `code`                                                                                               |
| ------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `PayloadTooLargeError`                | 413                | `payload_too_large` (+ `details.limit`, `details.contentType`)                                       |
| `MalformedBodyError`                  | 400                | `bad_request` (`message: "Malformed json body"`)                                                     |
| `UnsupportedMediaTypeError`           | 415                | `unsupported_media_type` (+ `details.receivedContentType`: рядок або `null`, `details.allowedKinds`) |
| `ValidationError`                     | `error.statusCode` | `error.code`, `details.kind: "validation"`                                                           |
| `ParameterValidationError`            | `error.statusCode` | `error.code`, `details.kind: "parameter_validation"`                                                 |
| `RedisUnavailableError`               | 503                | `service_unavailable`, заголовок `Retry-After: 1`                                                    |
| `SessionVerificationUnavailableError` | 503                | `service_unavailable`, заголовок `Retry-After: 1`                                                    |
| інше                                  | 500                | `internal_error` (текст помилки лише при `env === "local"`)                                          |

400, 413 і 415 логуються як `warn`, невідомі помилки — як `error` з контекстом для Sentry.

`RedisUnavailableError` ([redis-unavailable-error.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/network/errors/redis-unavailable-error.ts)) означає, що основний Redis-клієнт недоступний (з'єднання не `ready` або команда не вклалася в `REDIS_COMMAND_TIMEOUT_MS`). Відповідь — `503 service_unavailable` з `message: "Service temporarily unavailable. Try again later."` і `Retry-After: 1`; текст помилки ioredis у відповідь не потрапляє навіть при `APP_ENV=local`. Запис `logger.error` ("Request failed: Redis unavailable") лишається в stdout, але в Sentry не йде — див. [Observability](/backend/observability#відмова-redis). Сервісний шар (login, logout, `logoutAll`, WS-токен) дає той самий `503`: `tryInternal` у [result-helpers.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/shared/result-helpers.ts) повертає `AppError` `ServiceUnavailable`, коли причина — `RedisUnavailableError`. Формат тіла — `{ status: "error", code, message, details? }` (`sendErrorResponse`).

`SessionVerificationUnavailableError` ([session-verification-unavailable-error.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/network/errors/session-verification-unavailable-error.ts)) кидає `sessionHandler`, коли не вдалося звірити `userToken` сесії з `users.session_token` (БД недоступна). Відповідь така сама, `503 service_unavailable` з `Retry-After: 1`, без тексту драйвера: запит не обслуговується лише за записом сесії в Redis (див. [Відкликання сесій](/backend/auth#відкликання-сесіи)). На відміну від Redis-помилки, `logger.error` цього випадку йде і в Sentry: недоступність БД — інцидент.

## WebSocket: upgrade і повідомлення

Ендпоінт — `/<pathPrefix>/websocket` (`configureWebsockets`: `idleTimeout: 120`, `maxPayloadLength: 1 MB`, `maxBackpressure: 64 KB`, без компресії).

```mermaid
sequenceDiagram
  participant Client
  participant U as "handleUpgrade"
  participant Hooks as "WsAppHooks (app/start)"
  participant M as "onMessage"
  participant D as "ws-api-dispatcher"
  Client->>U: GET websocket, Sec-WebSocket-Protocol: token, appType
  U->>U: checkUpgradeRateLimit(ip)
  alt over the limit / limiter failed
    U-->>Client: 429 + Retry-After / 503
  end
  U->>U: checkToken(token)
  alt invalid format
    U-->>Client: 401 Unauthorized
  end
  U->>Hooks: onUpgrade(token)
  Hooks-->>U: sessionId, userId, userToken or null
  U-->>Client: res.upgrade(userData)
  Client->>M: JSON message
  M->>Hooks: onRefreshToken(token)
  M->>M: validate envelope, wsSessionHandler
  M->>D: message, session
  D->>D: rate limit, validator, middlewares, handler
  D-->>Client: JSON response
```

- **Upgrade** ([ws-handlers.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/network/ws-handlers.ts), `handleUpgrade`): спершу ліміт upgrade за IP (`429`/`503`), потім токен: він передається першим значенням `Sec-WebSocket-Protocol`, друге — тип застосунку (`web`/`pwa`). Невалідний формат → `401`. Хук `onUpgrade` (у [app/start/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/start/index.ts) це `wsSessionAuth.verifyUpgradeToken`) повертає дані доступу, які кладуться в `userData`.
- **Повідомлення** (`onMessage`): бінарні повідомлення ігноруються; рядок `ping` → `pong`; інакше JSON валідується зареєстрованим валідатором, перевіряється сесія (`wsSessionHandler`; без сесії — `closeExpiredSession`), і повідомлення передається в [ws-api-dispatcher.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/routing/ws-api-dispatcher.ts).
- **Диспетчер**: маршрут шукається за частиною `event` до `:`, далі `checkRateLimitWs`, `validateRoutePayload` (якщо є `validator`), middleware і handler. Невідома подія → помилка `not_found` («Route not found», [ws-api-dispatcher.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/routing/ws-api-dispatcher.ts); детальніше — [WebSocket](/backend/websocket)), помилки валідації → `validation_failed`, решта → `internal_error`.

Про сесії, CSRF і автентифікацію — див. [Автентифікація](/backend/auth) і [Безпека](/backend/security).

::: info Поза рамками
Ліміти тіла задаються лише за типом тіла: per-route лімітів немає, WS-ліміт (`maxPayloadLength`, 1 MB) не налаштовується через env. Історія рішень — [початковий план](https://github.com/Blazheiko/vibe-template/blob/main/docs/plan/http-body-limits-original-plan.md) і [план feat-008](https://github.com/Blazheiko/vibe-template/blob/main/docs/plan/http-body-limits-plan.md). Тіло `PATCH` читається; `DELETE` тіло свідомо не читає (див. [Роутинг → Методи і тіло запиту](/backend/routing#методи-і-тіло-запиту)).
:::
