# Аналіз реалізації ядра `packages/backend/src/vendor`

Дата: 2026-11-23  
Обсяг аналізу: `packages/backend/src/vendor` (~10.2 тис. рядків production-коду у 85 файлах та ~15.6 тис. рядків у 94 тестових файлах, включно з transport-, PG- та Redis-тестами).

---

## 1. Архітектура та зони відповідальності

`packages/backend/src/vendor` — це власне транспортно-інфраструктурне ядро на базі `uWebSockets.js`, яке покриває повний життєвий цикл HTTP/WebSocket-запитів і базову інфраструктуру бекенду:

- **HTTP/WS сервер і роутинг:**
  - [`start/server.ts`](../packages/backend/src/vendor/start/server.ts) — підняття `uWS.App()`, реєстрація HTTP/WS маршрутів, CORS, graceful shutdown, `broadcastToChannel`.
  - [`start/router.ts`](../packages/backend/src/vendor/start/router.ts) — нормалізація груп маршрутів, перевірка префіксів контрактів, валідація конфігурації `maxBodySize` / `signedInBeforeBody`, компіляція `ResponseSchema`.
  - [`utils/network/ws-handlers.ts`](../packages/backend/src/vendor/utils/network/ws-handlers.ts) та [`utils/routing/ws-api-dispatcher.ts`](../packages/backend/src/vendor/utils/routing/ws-api-dispatcher.ts) — upgrade, lifecycle сокетів, диспетчеризація WS-подій.
- **Роздача SPA та статики:**
  - [`start/static-server.ts`](../packages/backend/src/vendor/start/static-server.ts), [`start/static-build-meta.ts`](../packages/backend/src/vendor/start/static-build-meta.ts) — RAM-кеш із бюджетом пам'яті, pre-compressed `br`/`gzip`, потокова віддача великих файлів із диска, ETag/304, перевірка `API_PATH_PREFIX`.
- **Сесії, CSRF, індекс пристроїв і 2-фазна MFA-активація:**
  - [`utils/session/request-session.ts`](../packages/backend/src/vendor/utils/session/request-session.ts), [`utils/session/redis-session-storage.ts`](../packages/backend/src/vendor/utils/session/redis-session-storage.ts), [`utils/session/session-index.ts`](../packages/backend/src/vendor/utils/session/session-index.ts), [`utils/session/session-deletion-lock.ts`](../packages/backend/src/vendor/utils/session/session-deletion-lock.ts), [`utils/session/session-handler.ts`](../packages/backend/src/vendor/utils/session/session-handler.ts), [`utils/session/token-handler.ts`](../packages/backend/src/vendor/utils/session/token-handler.ts), [`utils/session/session-token-check.ts`](../packages/backend/src/vendor/utils/session/session-token-check.ts).
- **Rate limiting та бюджети ресурсів:**
  - [`utils/rate-limit/rate-limit-store.ts`](../packages/backend/src/vendor/utils/rate-limit/rate-limit-store.ts), [`utils/rate-limit/http-rate-limit.ts`](../packages/backend/src/vendor/utils/rate-limit/http-rate-limit.ts), [`utils/rate-limit/upgrade-rate-limit.ts`](../packages/backend/src/vendor/utils/rate-limit/upgrade-rate-limit.ts), [`utils/rate-limit/redis-sliding-log.ts`](../packages/backend/src/vendor/utils/rate-limit/redis-sliding-log.ts), [`utils/rate-limit/ws-connection-limit.ts`](../packages/backend/src/vendor/utils/rate-limit/ws-connection-limit.ts), [`utils/rate-limit/ws-message-budget.ts`](../packages/backend/src/vendor/utils/rate-limit/ws-message-budget.ts), [`utils/network/body-budget.ts`](../packages/backend/src/vendor/utils/network/body-budget.ts).
- **Валідація контрактів (вхід і вихід):**
  - [`utils/validation/validate-response.ts`](../packages/backend/src/vendor/utils/validation/validate-response.ts), [`utils/validation/flatten-query.ts`](../packages/backend/src/vendor/utils/validation/flatten-query.ts), [`utils/validation/validate-route-payload.ts`](../packages/backend/src/vendor/utils/validation/validate-route-payload.ts), [`utils/routing/serialize-routes.ts`](../packages/backend/src/vendor/utils/routing/serialize-routes.ts).
- **Спостережуваність і безпека помилок/заголовків:**
  - [`utils/logger.ts`](../packages/backend/src/vendor/utils/logger.ts), [`utils/errors/scrub-error.ts`](../packages/backend/src/vendor/utils/errors/scrub-error.ts), [`utils/network/errors/classify-error.ts`](../packages/backend/src/vendor/utils/network/errors/classify-error.ts), [`utils/network/csp.ts`](../packages/backend/src/vendor/utils/network/csp.ts), [`utils/network/get-ip.ts`](../packages/backend/src/vendor/utils/network/get-ip.ts), [`utils/network/ip-address.ts`](../packages/backend/src/vendor/utils/network/ip-address.ts).
- **Сховище:**
  - [`utils/storage/s3.ts`](../packages/backend/src/vendor/utils/storage/s3.ts), [`utils/storage/detect-image-type.ts`](../packages/backend/src/vendor/utils/storage/detect-image-type.ts).

---

## 2. Сильні сторони

### 2.1. Коректна робота зі специфікою `uWebSockets.js`
- **Синхронний знімок `HttpRequest` до першого `await`:** `collectRequestMetadata` у [`server.ts`](../packages/backend/src/vendor/start/server.ts#L157-L184) зчитує заголовки, cookies, query, params та IP синхронно, доки нативний об'єкт `req` валідний.
- **Синхронний rate-limit до читання body:** перевірки L1 та route-level виконуються до `res.onData()` ([`server.ts`](../packages/backend/src/vendor/start/server.ts#L514-L532)), що виключає втрату тіла коротких POST-запитів у `uWebSockets.js`.
- **Єдиний слот `res.onAborted()`:** реєструється один раз і протягується в читач тіла через `RequestAbortSignal`, а в хендлери — через стандартний `AbortController` ([`server.ts`](../packages/backend/src/vendor/start/server.ts#L488-L498)).
- **Контроль `cork()` і `backpressure`:** усі асинхронні відповіді обгорнуті в `res.cork()` / `ws.cork()`; перевищення `maxBackpressure` у WS (`ws.send() === 2`) коректно закриває сокет із кодом `1013` ([`ws-handlers.ts`](../packages/backend/src/vendor/utils/network/ws-handlers.ts#L138-L146)); великі статичні файли віддаються потоково через `res.tryEnd` + `res.onWritable` із захистом від усічених файлів ([`static-server.ts`](../packages/backend/src/vendor/start/static-server.ts#L289-L366)).
- **Захист від звернень до мертвих WS-сокетів:** `userData.closed` виставляється синхронно на початку `onClose` до будь-якого `await` ([`ws-handlers.ts`](../packages/backend/src/vendor/utils/network/ws-handlers.ts#L553-L565)).

### 2.2. Глибокий захист від DoS та зловживань (Defense-in-Depth)
- **HTTP-пайплайн:** `L1 global rate limit -> route rate limit -> query validation -> signedInBeforeBody (перевірка HMAC cookie до буферизації тіла) -> Content-Type & Content-Length -> почанковий in-flight body budget` ([`body-budget.ts`](../packages/backend/src/vendor/utils/network/body-budget.ts)). Це закриває slow-body OOM та анонімні завантаження великих payload.
- **WebSocket:**
  - Двошаровий upgrade rate-limit: синхронний локальний L1 + кластерний Redis sliding log L2 ([`upgrade-rate-limit.ts`](../packages/backend/src/vendor/utils/rate-limit/upgrade-rate-limit.ts)).
  - Обмеження одночасних відкритих з'єднань per-user і per-IP ([`ws-connection-limit.ts`](../packages/backend/src/vendor/utils/rate-limit/ws-connection-limit.ts)).
  - Per-connection бюджет повідомлень/пінгів та одночасно активних хендлерів (`maxConcurrentHandlers`) із закриттям кодом `4029` при повторному флуді ([`ws-message-budget.ts`](../packages/backend/src/vendor/utils/rate-limit/ws-message-budget.ts)).
  - Негайне відхилення бінарних фреймів (`1003`) і невідомих WS-подій із пам'яті до будь-якого звернення в Redis/PostgreSQL ([`ws-handlers.ts`](../packages/backend/src/vendor/utils/network/ws-handlers.ts#L314-L317), [`L394-L401`](../packages/backend/src/vendor/utils/network/ws-handlers.ts#L394-L401)).
- **IP/Proxy резолвінг ([`get-ip.ts`](../packages/backend/src/vendor/utils/network/get-ip.ts), [`ip-address.ts`](../packages/backend/src/vendor/utils/network/ip-address.ts)):**
  - Об'єднання повторюваних заголовків `X-Forwarded-For` за RFC 9110 §5.3.
  - Обхід ланцюжка справа наліво з зупинкою (fail-closed) при невалідному записі.
  - Нормалізація IPv4-mapped IPv6 (`::ffff:0:0/96`) і групування IPv6 по `/64` для rate-limit ключів.

### 2.3. Надійна модель сесій і консистентності
- **Анонімні сесії без запису в Redis:** зберігаються у підписаній cookie (`anon-v1`), не засмічуючи Redis ботами, і переносяться в Redis лише при збереженні даних ([`request-session.ts`](../packages/backend/src/vendor/utils/session/request-session.ts#L487-L503), [`token-handler.ts`](../packages/backend/src/vendor/utils/session/token-handler.ts#L97-L128)).
- **Атомарні Lua-скрипти в Redis:**
  - Попередня перевірка `TYPE` кожного ключа до запису в мульти-ключових скриптах ([`session-index.ts`](../packages/backend/src/vendor/utils/session/session-index.ts#L32-L110)), що запобігає частковим записам при `WRONGTYPE`.
  - CAS-оновлення (`COMPARE_AND_SET_LUA`) і атомарне `consumeSessionData` для одноразових токенів/OAuth state ([`redis-session-storage.ts`](../packages/backend/src/vendor/utils/session/redis-session-storage.ts#L198-L333)).
  - Ідемпотентна 2-фазна активація MFA-сесій (`preparePendingSession -> activatePendingSession -> claimActivationEffects`).
- **Захист від race conditions:**
  - `beforeSend` (`discardStaleCookie` у [`request-session.ts`](../packages/backend/src/vendor/utils/session/request-session.ts#L822-L852)) блокує відправку застарілої `Set-Cookie`, якщо паралельний запит уже виконав login/logout.
  - `deleteUnderLock` ([`session-deletion-lock.ts`](../packages/backend/src/vendor/utils/session/session-deletion-lock.ts)) синхронізує видалення сесії з привілейованими операціями в PostgreSQL із точною класифікацією SQLSTATE (`busy` / `connection_lost` / `unreachable`).
  - Fail-closed звірка з `users.sessionToken` за ADR 0002 ([`session-token-check.ts`](../packages/backend/src/vendor/utils/session/session-token-check.ts)).

### 2.4. Захист від витоків даних у відповідях і логах
- **Runtime-перевірка відповідей ([`validate-response.ts`](../packages/backend/src/vendor/utils/validation/validate-response.ts)):** валідація payload проти `ResponseSchema` (ArkType), перевірка на prototype-ключі (`__proto__`, `constructor`), кастомні `toJSON` / не-plain екземпляри та `Infinity`/`NaN`. У логи та Sentry потрапляють лише шляхи полів без значень (PII), із тротлінгом по маршруту та типу проблеми.
- **Скрабінг помилок ([`scrub-error.ts`](../packages/backend/src/vendor/utils/errors/scrub-error.ts), [`logger.ts`](../packages/backend/src/vendor/utils/logger.ts)):** глибоке copy-on-write очищення помилок `pg` / `DrizzleQueryError` (видалення `query`, `params`, `detail`, `where`, перебудова `stack` без заголовка, захист від циклів і кастомних `toJSON`) на рівні `logMethod`, `formatters.log`, `serializers` і `child()` bindings до потрапляння в stdout або Sentry.

### 2.5. Статика та заголовки безпеки
- Pre-compressed `br`/`gzip`, контентний ETag (SHA-1), обмеження обсягу RAM-кешу, роздільні CSP-політики (`document`, `svg`, `strict` у [`csp.ts`](../packages/backend/src/vendor/utils/network/csp.ts)), `Cache-Control: no-store` за замовчуванням для API ([`http-response-handlers.ts`](../packages/backend/src/vendor/utils/network/http-response-handlers.ts#L111-L115)) та перевірка відповідності `API_PATH_PREFIX` зібраного SPA ([`static-server.ts`](../packages/backend/src/vendor/start/static-server.ts#L188-L194)).

---

## 3. Слабкі місця, компроміси та технічний борг

### 3.1. Розмита межа `vendor` ↔ `app` / `config` / `database`
Частина модулів реалізує інверсію залежностей через реєстрацію хуків при старті (`registerWsAppHooks`, `registerSessionTokenChecker`, `registerSessionDeletionLock`, `registerSignInCompletionHook`), але водночас `vendor` має прямі імпорти з `#app/*`, `#config/*` та `#database/*`:
- `#app/state/state.js` — [`server.ts`](../packages/backend/src/vendor/start/server.ts#L7)
- `#app/middlewares/kernel.js` — [`execute-httpMiddlewares.ts`](../packages/backend/src/vendor/utils/middlewares/core/execute-httpMiddlewares.ts#L1)
- `#app/services/observability/sentry-service.js` — [`logger.ts`](../packages/backend/src/vendor/utils/logger.ts#L3), [`validate-response.ts`](../packages/backend/src/vendor/utils/validation/validate-response.ts#L3)
- `#app/validate/checkers/*` — [`http-request-handlers.ts`](../packages/backend/src/vendor/utils/network/http-request-handlers.ts#L3-L6)
- `#app/validate/errors/validation-error.js` — [`ws-handlers.ts`](../packages/backend/src/vendor/utils/network/ws-handlers.ts#L47), [`flatten-query.ts`](../packages/backend/src/vendor/utils/validation/flatten-query.ts#L1), [`validate-route-payload.ts`](../packages/backend/src/vendor/utils/validation/validate-route-payload.ts#L1)
- `#database/redis.js` та `#database/redis-rate-limit.js` — у session storage, session index та upgrade rate-limit.

При цьому архітектурний тест [`layering.spec.ts`](../packages/backend/src/app/layering.spec.ts) перевіряє лише `src/app/**` і не контролює напрямок залежностей `src/vendor/**`.

Також [`utils/storage/s3.ts`](../packages/backend/src/vendor/utils/storage/s3.ts) концептуально є адаптером зовнішнього сховища (у коментарях навіть згаданий бізнес-домен LLM/HTML), а не частиною HTTP/WS-ядра.

### 3.2. Top-level side-effects та модульні синглтони
Імпорт низки модулів одразу виконує побічні дії:
- `uWS.App()` у [`server.ts`](../packages/backend/src/vendor/start/server.ts#L87);
- перевірка `APP_KEY` на top-level у [`token-handler.ts`](../packages/backend/src/vendor/utils/session/token-handler.ts#L9-L19);
- створення `S3Client` у [`s3.ts`](../packages/backend/src/vendor/utils/storage/s3.ts#L24);
- запуск `setInterval` GC у [`rate-limit-store.ts`](../packages/backend/src/vendor/utils/rate-limit/rate-limit-store.ts#L222-L227);
- `process.exit(1)` при збої ініціалізації у [`logger.ts`](../packages/backend/src/vendor/utils/logger.ts#L210).

Через top-level перевірку `APP_KEY` довелося **дублювати логіку HMAC-підпису** у [`signed-in-cookie.ts`](../packages/backend/src/vendor/utils/session/signed-in-cookie.ts#L6-L17) замість перевикористання `token-handler.ts`, а для тестів підтримувати численні `__reset*ForTests` хуки.

### 3.3. Обмеження горизонтального масштабування (свідомі компроміси)
- HTTP rate limits, WS connection limits, WS message budget і `body-budget` зберігаються **in-memory per-process** (при N інстансах ефективний ліміт = N×).
- Мульти-ключові Lua-скрипти в [`session-index.ts`](../packages/backend/src/vendor/utils/session/session-index.ts#L29-L30) не використовують Redis Cluster hash tags (`{userToken}`), тому перехід на Redis Cluster вимагатиме міграції формату ключів.

### 3.4. Розмір ключових модулів і протікання доменної логіки
- [`request-session.ts`](../packages/backend/src/vendor/utils/session/request-session.ts) (865 рядків), [`server.ts`](../packages/backend/src/vendor/start/server.ts) (811 рядків) та [`ws-handlers.ts`](../packages/backend/src/vendor/utils/network/ws-handlers.ts) (764 рядки) помітно перевантажені.
- `request-session.ts` і [`types.d.ts`](../packages/backend/src/vendor/types/types.d.ts) поєднують базову механіку сесій із доменно-специфічною оркестрацією MFA/recovery/staff-доступу (`planLogin`, `prepareLogin`, `activateLogin`, `mfaTicketCookieName`, `staffAccessDeadline`, `allowInRecovery`).

### 3.5. Дрібні недоліки та мертвий код
- **Ігнорований параметр у WS-контексті:** [`ws-context.ts`](../packages/backend/src/vendor/utils/context/ws-context.ts#L17-L33) приймає `_session: Session | null`, але завжди повертає `session: null, auth: null`, хоча [`ws-api-dispatcher.ts`](../packages/backend/src/vendor/utils/routing/ws-api-dispatcher.ts#L82) передає туди завантажену сесію.
- **Невикористаний код:**
  - [`start/validators.ts`](../packages/backend/src/vendor/start/validators.ts) (`ValidatorFunction` map) — ніде не імпортується (залишок старої схеми валідації);
  - `isValidUrl` у [`http-request-handlers.ts`](../packages/backend/src/vendor/utils/network/http-request-handlers.ts#L298) — експортується, але не викликається в production-коді;
  - `UserConnection.ip2` у [`ws-handlers.ts`](../packages/backend/src/vendor/utils/network/ws-handlers.ts#L742) — записується при upgrade, але ніде не читається.
- **Локальні деталі:**
  - `ResponseData.setHeader` ([`response-data.ts`](../packages/backend/src/vendor/utils/network/response-data.ts#L59-L61)) робить `headers.push(...)` без заміни або дедуплікації однакових імен заголовків.
  - У `parseMultipart` створюється новий `TextDecoder()` на кожну не-файлову частину в циклі ([`http-request-handlers.ts`](../packages/backend/src/vendor/utils/network/http-request-handlers.ts#L233)).
  - Ключі кешу статики формуються через `filePath.substring(STATIC_PATH.length)` ([`static-server.ts`](../packages/backend/src/vendor/start/static-server.ts#L140)) — прив'язка до POSIX-розділювача `/` та `process.cwd()`.
  - Неоднорідність імпортів усередині `vendor`: змішані `'crypto'` ([`http-context.ts`](../packages/backend/src/vendor/utils/context/http-context.ts#L4), [`ws-context.ts`](../packages/backend/src/vendor/utils/context/ws-context.ts#L11)) і `'node:crypto'`, `#logger` vs `#vendor/utils/logger.js`, відносні шляхи vs `#vendor/*`.

---

## 4. Підсумкове резюме та рекомендації

**Вердикт:** `packages/backend/src/vendor` — це **зріле, загартоване (battle-hardened) і дуже добре протестоване production-ядро**, значно сильніше за типові кастомні обгортки над `uWebSockets.js`. Критичних проблем безпеки або стабільності під навантаженням не виявлено: класичні пастки `uWebSockets.js`, HTTP/WS DoS-вектори, race conditions сесій, витоки PII/SQL у логах і відповідях закриті системно й покриті регресійними тестами.

**Пріоритетні покращення (планово, без терміновості):**
1. **Закріпити архітектурну межу:** перенести `ValidationError` і базові checkers (`header`/`parameter`/`cookie`) у `vendor` (або винести інжекцію `sentryService` / `kernel` / `state` через явну реєстрацію при старті) та додати перевірку `vendor -> !app` у [`layering.spec.ts`](../packages/backend/src/app/layering.spec.ts).
2. **Прибрати top-level side-effects при імпорті:** винести валідацію `APP_KEY` у явну функцію ініціалізації (це дозволить усунути дублювання HMAC у `signed-in-cookie.ts`).
3. **Розвантажити `request-session.ts` і почистити техборг:** відокремити оркестрацію 2-фазної MFA-активації від базового життєвого циклу сесії, визначитися з контрактом `_session` у `ws-context.ts`, видалити мертвий код (`start/validators.ts`, `isValidUrl`, `ip2`) та уніфікувати імпорти (`node:crypto`).
