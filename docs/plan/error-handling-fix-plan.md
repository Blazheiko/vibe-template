# План виправлення обробки помилок і переускладнень backend

Дата: 2026-11-02. Джерело: code review гілки `main` (commit `152ca34`). Звірено з кодом повторно після рев'ю плану (2026-11-02).

**Мета:**

- кожна 5xx помилка потрапляє в лог;
- у Sentry потрапляє все, крім недоступності Redis: для неї діє наявна політика «одна подія на інцидент»;
- HTTP і WebSocket класифікують виняток однією функцією, а відповідь форматує кожен транспорт сам;
- прибрати дублювання, яке з'явилося через `Result` для інфраструктурних збоїв.

Рухатися малими PR, кожен етап — окремий `feat-XXX` у `feature_list.json` (через PR у `main`).

**Зворотна сумісність не потрібна.** Шаблон ще в розробці, продакшну немає. Тіла помилок, коди, тексти повідомлень і типи відповідей змінюємо вільно. Умова одна: `shared`, frontend, `api-playground`, тести й `documentation/` оновлюються в тому ж PR, щоб `main` завжди був узгоджений. Перехідних шарів, аліасів і фолбеків не додаємо, а наявні прибираємо (етап 7).

## Обсяг

| Етап | Проблема                                                                    | Пріоритет | Критерій готовності                                                                                        |
| ---- | --------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| 1    | 5xx `AppError` (`Internal`, `ServiceUnavailable`, `Upstream*`) не логуються | 🔴        | Кожна 5xx відповідь з `AppError` дає один запис `error` з `cause` і `requestId`; Redis-причини не в Sentry |
| 2    | Класифікація винятку продубльована в HTTP і WS; у WS є баги                 | 🟠        | HTTP і WS викликають одну `classifyError(err)`; тіло HTTP і конверт WS форматуються окремо                 |
| 3    | Дрібне сміття в `server.ts`, `session-handler.ts` і контролерах             | 🟡        | 3a — без змін поведінки; 3b — свідома зміна лог-потоку, описана в PR                                       |
| 4    | 108 викликів `tryInternal` і 147 ручних прокидань `Result.err(x.error)`     | 🟡        | Інфраструктурні збої кидаються; `Result` лише для очікуваних бізнес-результатів (ADR)                      |
| 5    | Повторюваний шаблон у контролерах                                           | 🟢        | Один helper замість однакових блоків `isError → mapControllerError`                                        |
| 6    | `sessionHandler` — 300-рядкове замикання зі змінним станом                  | 🟢        | Окремий клас стану сесії, тести сесій і CSRF зелені                                                        |
| 7    | Код сумісності, який більше не потрібен                                     | 🟡        | Немає фолбеку на старий cookie, `LegacyLoginInputSchema`, аліасу `routeItem`                               |

Залежності:

- 1 → 3b: прибирати log-and-rethrow можна лише тоді, коли причина вже логується вище.
- 1 → 4: етап 4 спирається на логування з етапу 1 для залишкових `Internal`.
- 2 → 4: після етапу 4 сирі винятки, зокрема помилки ioredis від rate-limit клієнта, ідуть у `classifyError`, тож вона має їх розпізнавати.
- 7 → 6: без legacy-cookie гілок `sessionHandler` простіший для рефакторингу.

Етапи 3a, 5 і 7 незалежні.

### Політика логування, яку зберігають усі етапи

Це наявні правила, які зараз розкидані по `handleError` ([`server.ts:391`](../../packages/backend/src/vendor/start/server.ts)) і [`logger.ts`](../../packages/backend/src/vendor/utils/logger.ts). Етапи 1, 2 і 4 переносять їх в одне місце, а не змінюють:

| Випадок                                                                                    | Рівень  | Sentry                                               | Відповідь                                        |
| ------------------------------------------------------------------------------------------ | ------- | ---------------------------------------------------- | ------------------------------------------------ |
| 4xx (валідація, 413, 415, битий body, параметр, бізнес-4xx)                                | `warn`  | ні                                                   | без змін                                         |
| Недоступність Redis (`isRedisUnavailable(err)` або `cause`; голий код сокета не рахується) | `error` | **ні**: одна подія на інцидент дає `redis-health.ts` | 503 `service_unavailable`, `Retry-After: 1`      |
| `SessionVerificationUnavailableError`                                                      | `error` | так                                                  | 503 `service_unavailable`, `Retry-After: 1`      |
| Решта 5xx                                                                                  | `error` | так                                                  | 500 `internal_error` (у `local` — `String(err)`) |

**Чому Redis треба фільтрувати явно.** `isRedisUnavailableEntry` у `logger.ts:59` пропускає подію в Sentry лише тоді, коли `err.type === 'RedisUnavailableError'`. Цю обгортку кидає тільки main-клієнт. Rate-limit клієнт ([`redis-rate-limit.ts`](../../packages/backend/src/database/redis-rate-limit.ts)) кидає сирі помилки ioredis, а `toInternalError` перетворює їх на `ServiceUnavailable` з сирою `cause`. Якщо логувати таку `cause` як `err`, фільтр не спрацює, і кожен запит під час інциденту створить окрему подію в Sentry. Тому рішення «Redis чи ні» приймає код через `isRedisUnavailable()`, а в лог передає `sentrySkip: true`: це поле `logger.ts` уже підтримує (рядок 82).

**Відкрите питання (не блокує).** У rate-limit клієнта немає свого `redis-health`, він пише тільки `warn` (`redis-rate-limit.ts:39,49`). Отже, його інцидент не дає жодної події в Sentry. Так є і зараз; якщо це треба змінити, це окрема задача.

## Етап 1 — логування 5xx `AppError` (🔴)

**Проблема.** `tryInternal` ([`result-helpers.ts`](../../packages/backend/src/app/services/shared/result-helpers.ts)) ловить виняток і кладе його в `AppError.cause`. Далі `mapControllerError` ([`controller-error.ts`](../../packages/backend/src/app/controllers/shared/controller-error.ts)) і WS-контролери (`appErrorToPayload` у [`ws/support-controller.ts`](../../packages/backend/src/app/controllers/ws/support-controller.ts), [`ws/admin-ws-controller.ts`](../../packages/backend/src/app/controllers/ws/admin-ws-controller.ts)) лише формують відповідь. У Sentry потрапляє тільки `logger.error`, тому 500 від падіння S3 чи БД ніде не видно.

**Зміни.**

1. Додати в `services/shared/` функцію `reportAppError(logger, error)` за таблицею політики:
    - `appErrorStatus(error) < 500` — нічого не логувати, це очікувані відповіді;
    - інакше `logger.error({ err: error.cause ?? error, appError: error._tag, ...(isRedisUnavailable(error.cause) ? { sentrySkip: true } : {}) }, appErrorMessage(error))`.
2. Викликати її з `mapControllerError` (через `context.logger`, щоб був `requestId`/`userId`) і з WS-контролерів (`refuse` у support-controller, admin-ws-controller). Сигнатуру `mapControllerError` розширити до `Pick<HttpContext, 'responseData' | 'logger'>`.
3. Прибрати наявні ручні `logger.error` у контролерах і сервісах лише там, де вони логують **той самий** `AppError` перед поверненням, щоб не було подвійних подій у Sentry. Ручні `warn` для best-effort гілок (наприклад, видалення старого аватара) не чіпати.
4. **Додано під час реалізації (ручна перевірка).** `isRedisUnavailable` вважала Redis-збоєм будь-яку помилку з кодом `ECONNREFUSED` / `ECONNRESET` / `ETIMEDOUT` / `EPIPE`. Через `toInternalError` недоступний S3 давав 503 «спробуйте пізніше» замість 500, а з п. 1 ще й отримав би `sentrySkip`, тобто зник би з Sentry. Перевірку розділено:
    - `isRedisUnavailable` — для помилки з невідомого джерела: лише ознаки, які дає тільки ioredis (обгортка `RedisUnavailableError`, `MaxRetriesPerRequestError`, повідомлення `Command timed out` / `Connection is closed` / `Stream isn't writeable`). Rate-limit клієнт (`enableOfflineQueue: false`, `maxRetriesPerRequest: 0`, `commandTimeout`) падає саме з ними;
    - `isRedisCommandUnavailable` — для помилки Redis-команди в `withRedis` (`redis-health.ts`): додатково голі коди сокета, бо джерело відоме.

    Наслідок: падіння S3, PostgreSQL чи SMTP з кодом сокета тепер дає 500 `internal_error` і подію в Sentry, а не 503.

**Тести.** `controller-error.spec.ts`:

- 500 → один `error` з `cause`;
- 503 з `RedisUnavailableError` → `error` + `sentrySkip`;
- 503 із сирою ioredis-помилкою (`Stream isn't writeable`, `Command timed out`, `MaxRetriesPerRequestError`) → `error` + `sentrySkip`;
- голий `ECONNREFUSED` з іншого сервісу (S3) → `Internal`, без `sentrySkip`;
- 404/409 → без логу.

Окремо: тест на `logger.ts`, що запис із `sentrySkip` не доходить до `sentryService.captureException`; тест для WS `refuse`; регресія для `avatar-service` — падіння `uploadToS3` дає 500 і запис у лозі.

**Документація.** [`observability.md`](../../documentation/backend/observability.md): 5xx бізнес-помилки логуються в контролерному шарі, Redis-причини йдуть із `sentrySkip`. [`controllers.md`](../../documentation/backend/controllers.md): нова сигнатура `mapControllerError`.

## Етап 2 — спільна класифікація, окреме форматування (🟠)

**Основа.** feat-048 (`done`, [`ws-error-envelope-plan.md`](./ws-error-envelope-plan.md)) уже зробив WS-конверт однаковим: `data: null`, один будівник у [`ws-error-envelope.ts`](../../packages/backend/src/vendor/utils/network/ws-error-envelope.ts). Він також свідомо розвів два види помилок: транспортні помилки WS ідуть у `error`, бізнес-помилки контролерів і middleware — у `data`. Етап 2 будує на цьому і **не змінює** контрактів feat-048: не переносить бізнес-помилки з `data` і не змінює зовнішній конверт `{ event, timestamp, status, data, error }`. Він замінює лише те, як виняток стає кодом, повідомленням і рівнем логу.

**Проблема.**

- HTTP: `handleError` ([`server.ts:391`](../../packages/backend/src/vendor/start/server.ts)) — ланцюжок `instanceof` на 7 класів, хоча всі вже мають `statusCode` і `code`. Гілки `RedisUnavailableError` і `SessionVerificationUnavailableError` однакові.
- WS класифікує винятки ще у двох місцях: у [`ws-handlers.ts:229-299`](../../packages/backend/src/vendor/utils/network/ws-handlers.ts) і в [`ws-api-dispatcher.ts:110-140`](../../packages/backend/src/vendor/utils/routing/ws-api-dispatcher.ts). Кожне місце має свою копію `details` для валідації.
- WS-баги:
    - `onMessage` обгортає одним `try` і `JSON.parse`, і всю подальшу обробку, а в `catch` пише `error`. Тому битий JSON іде в Sentry і отримує `internal_error`, хоча в HTTP та сама ситуація дає `warn` і 400. Будь-який клієнт може засмічувати Sentry;
    - `RedisUnavailableError` / `SessionVerificationUnavailableError` з WS-контролера потрапляють у загальну гілку і дають `internal_error` замість `service_unavailable`;
    - відповідь про помилку валідації повідомлення йде з `event: ''`, і клієнт не може зіставити її із запитом;
    - гілка `ValidationError` в `onMessage` мертва.
- `handleError` розпізнає лише клас `RedisUnavailableError`, а не `isRedisUnavailable()`. Після етапу 4 це дасть 500 замість 503 для збоїв rate-limit клієнта.

**Зміни.**

1. **Класифікація (спільна).** Базовий клас `HttpError extends Error` у `vendor/utils/network/errors/` з полями `statusCode`, `code`, `publicMessage`, `details?()`, `headers?`. Перевести на нього 7 наявних класів. Чиста функція `classifyError(err): ClassifiedError`, де `ClassifiedError = { status: number; code; message; details?; headers; logLevel: 'warn' | 'error'; sentrySkip: boolean; logFields }`, працює за таблицею політики. Гілки перевіряються **строго в такому порядку**, і перша, що збіглася, дає результат:
    1. `isRedisUnavailable(err)` → 503 `service_unavailable`, `Retry-After: 1`, `logLevel: 'error'`, `sentrySkip: true`. Ця гілка стоїть першою, бо `RedisUnavailableError` після переходу теж буде `HttpError`, а `isRedisUnavailable` повертає для нього `true` (`redis-unavailable-error.ts:27`). Інакше загальна гілка `HttpError` перехопила б його без `sentrySkip`, і кожен запит під час інциденту став би окремою подією в Sentry. Результат гілка будує сама, а не з полів класу, тому `Retry-After` і `sentrySkip` однакові і для обгортки main-клієнта, і для сирої ioredis-помилки rate-limit клієнта.
    2. `HttpError` → з його полів, `logLevel` = `warn` для 4xx і `error` для 5xx, `sentrySkip: false`. Сюди потрапляє і `SessionVerificationUnavailableError`: 503 з `Retry-After: 1` із полів класу, подія в Sentry є.
    3. Решта → 500 `internal_error`, `error`, `sentrySkip: false`.

    Порядок фіксується коментарем у коді й тестом (див. «Тести»). Фільтр `isRedisUnavailableEntry` у `logger.ts` лишається як друга лінія захисту, але класифікатор на нього не покладається.
    - `SyntaxError` з `JSON.parse` WS-повідомлення тут не розпізнається, це робиться явно в `onMessage` (п. 4), щоб не сховати справжні `SyntaxError` у коді.

2. **Внутрішнє тіло помилки.** `{ code, message, details? }` однакове для обох транспортів. Під час реалізації з'ясувалося, що `details` уже відповідають контракту `ErrorDetails` у `shared/src/errors/error-codes.ts` (у кожного класу свій `kind`; помилки без деталей їх просто не мають). Тому тіла відповідей не змінювались. Виправлено лише тип: `receivedContentType` у `shared` став `string | null`, бо сервер уже відповідав `null`, коли немає заголовка `Content-Type`.
3. **Форматування (окреме для кожного транспорту).**
    - HTTP: `handleError` = `classifyError` + лог + `sendErrorResponse(res, status, { status: 'error', ...body }, headers)`. HTTP-статус і заголовки (`Retry-After`) — частина HTTP-відповіді.
    - WS: диспетчер і `onMessage` = `classifyError` + лог + `setWsError(responseData, createWsErrorEnvelope(code, message, { details }))`. HTTP-статус і `headers` у WS не потрапляють, конверт лишається таким, як у feat-048.
    - Лог в обох випадках — одна функція `logClassifiedError(logger, classified, err)`, яка ставить `logLevel` і `sentrySkip`.
4. **`onMessage`.** Окремий `try` навколо `JSON.parse` → `bad_request`, `warn` без тіла повідомлення. Після парсингу взяти `event`/`timestamp` з об'єкта ще до валідації, якщо це рядок і число, щоб відповідь про помилку валідації мала правильний `event`. Прибрати мертву гілку `ValidationError`.

**Тести.**

- `classifyError` — таблиця для кожного класу, для сирої ioredis-помилки (503, `Retry-After`, `sentrySkip`) і для невідомої помилки.
- Окремий тест на пріоритет Redis: `new RedisUnavailableError()` перевіряється на `instanceof HttpError === true` і водночас дає `sentrySkip: true`, `Retry-After: 1` і 503. Якщо хтось переставить гілки, тест упаде. Контрольний випадок: `SessionVerificationUnavailableError` дає 503 з `Retry-After`, але `sentrySkip: false`.
- HTTP: `http-*.spec.ts` і `security-regressions.spec.ts` оновити під вирівняні `details`. Окремо перевірити, що 503 зберігає `Retry-After: 1` для обох причин, а 4xx логуються на `warn`.
- WS: `ws-error-envelope.spec.ts` і `ws-redis-unavailable.spec.ts` мають лишитися зеленими (конверт не змінюється). Нові тести: битий JSON → `bad_request` і **немає** `logger.error`; WS-контролер кидає `RedisUnavailableError` → `service_unavailable` без події в Sentry; невалідне повідомлення з `event` → відповідь з тим самим `event`; бізнес-помилка контролера як і раніше йде в `data`.
- `shared` і frontend: типи та обробка `details`, якщо їх зачепило вирівнювання.

**Документація.** [`websocket.md`](../../documentation/backend/websocket.md): коди транспортних помилок (`bad_request` для битого JSON, `service_unavailable`), розподіл транспортна/бізнес-помилка без змін. [`request-lifecycle.md`](../../documentation/backend/request-lifecycle.md): одна класифікація, окреме форматування. Позначку «Статус: план (не реалізовано)» у шапці `ws-error-envelope-plan.md` виправити, бо feat-048 уже `done`.

## Етап 3 — прибирання

### 3a — без змін поведінки (🟡)

Можна разом з етапом 2 або окремим PR:

- `server.ts`:
    - один імпорт `#config/app.js` замість `appConfig` + `configApp`;
    - прибрати псевдонім `getResponseData`;
    - видалити закоментований код (рядки ~126-130, 373-375, 783);
    - перекласти англійською коментар на рядках 584-586;
    - зробити `docRoutesHandler` синхронним, без `new Promise`.
- `ws-api-dispatcher.ts:83`: прибрати `context as unknown as HttpContext`. Для цього визначити спільний тип контексту middleware (`MiddlewareContext`), який задовольняють обидва транспорти. Якщо це тягне велику зміну типів, лише записати як відкритий пункт.

### 3b — зміна лог-потоку (🟡, після етапу 1)

Це свідома зміна того, що і де логується. У PR перелічити, які записи зникають і хто тепер логує ту саму подію:

- `session-handler.ts:376,408,441`: прибрати log-and-rethrow в `auth.login`, `auth.logout`, `auth.logoutAll`. Подію логує один раз рівень вище: `reportAppError` (етап 1), а після етапу 4 — `handleError`. Тест: збій `createSessionInfo` під час login дає рівно один запис `error`.
- Контролери: прибрати `context.logger.info('xxx handler')`. Маршрут і `requestId` уже є в контексті логера. Якщо потрібен access log, це окремий запис у `server.ts`, а не рядок у кожному методі.

## Етап 4 — `Result` лише для очікуваних результатів (🟡)

**Обсяг (HEAD `152ca34`, `packages/backend/src/app`, без `*.spec.ts`/`*.test.ts`).** Перед стартом кожного PR перерахувати тими самими командами:

| Що                                     | Число | Команда                                                                                                                                    |
| -------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Виклики `tryInternal(`                 | 108   | `grep -rn "tryInternal(" src/app \| grep -v "\.spec\.\|\.test\.\|export function" \| wc -l`                                                |
| Точне прокидання `Result.err(x.error)` | 147   | `grep -rn -A1 "if (Result.isError(" src/app/services \| grep -v "\.spec\.\|\.test\." \| grep -cE "return Result\.err\([A-Za-z]+\.error\)"` |
| Усі `Result.isError(` у сервісах       | 171   | `grep -rn "Result.isError(" src/app/services \| grep -v "\.spec\.\|\.test\." \| wc -l`                                                     |
| Spec-файли з текстами `Failed to …`    | 14    | `grep -rl "Failed to " src \| grep -E "\.(spec\|test)\.ts$" \| wc -l`                                                                      |

Команди запускати з `packages/backend`. `tryInternal(` по сервісах: `auth-service` 33, `password-reset-service` 14, `knowledge-base-service` 13, `push-subscription-service` 10, `avatar-service` 7, `oauth-service` 7, `email-verification-service` 6, `support-service` 5, `sms-challenge` 5, `one-time-token` 5, `main-service` 2, `enforce-throttle` 1.

**Проблема.** Кожен виклик БД, Redis, S3 чи хешування обгорнуто в `tryInternal` плюс ручне прокидання помилки. Неочікувані збої вже правильно обробляє глобальний handler, тож обгортка його дублює і (до етапу 1) губила логи. Приклад — `authService.login` ([`auth-service.ts:949`](../../packages/backend/src/app/services/auth/auth-service.ts)): половина методу займає прокидання помилок.

**Рішення.** Записати як короткий `docs/adr/0004-result-for-expected-outcomes.md`. Це не дозвіл на зміну, а фіксація конвенції для нових сервісів і skill `backend-feature`.

- `Result<T, AppError>` — для того, що клієнт має розрізняти: `invalid credentials`, `not found`, `conflict`, throttling, `forbidden`, upstream AI-помилки з власним кодом.
- Збої інфраструктури — кидати. `classifyError` з етапу 2 дає 500/503 і логує за таблицею політики, зокрема `sentrySkip` для Redis.
- Де багато послідовних кроків з `Result`, використовувати `Result.gen` + `yield*` (є в `better-result@3.0.1`).

**Наслідки.**

- Публічні повідомлення на кшталт `Failed to upload avatar` стають `Internal server error`. Це прийнятно, бо сумісність не потрібна. Frontend і 14 spec-файлів оновлюються в тому ж PR.
- Throttling через rate-limit клієнт (`enforce-throttle`) зараз дає 503 через `toInternalError`. Після етапу 4 він дає ті самі 503 через `classifyError`; це перевіряє тест.
- Місця, де `Internal` свідомо перехоплюється (наприклад, `email-verification-service.ts:238` — код `23505` унікального індексу), перевести на явний `try/catch` і бізнес-`conflict`.
- Best-effort кроки (`resetAuthThrottle` у login, видалення старого аватара) лишити з локальним `catch` + `warn`.

**Порядок.** Перехідний період не потрібен, тому три PR, згруповані за розміром:

1. `avatar-service` (пілот, на ньому перевірити підхід), `push-subscription-service`, `knowledge-base-service`, `support-service`, `main-service` — 37 викликів.
2. `oauth-service`, `email-verification-service`, `password-reset-service`, `sms-challenge`, `one-time-token` — 37 викликів.
3. `auth-service`, `enforce-throttle` — 34 виклики. Після цього `tryInternal` і `toInternalError` видалити повністю.

**Документація.** [`services.md`](../../documentation/backend/services.md), [`adding-a-feature.md`](../../documentation/backend/adding-a-feature.md), skill `backend-feature` (шаблон сервісу).

## Етап 5 — helper для контролерів (🟢)

Після етапу 4 частина блоків зникне сама. Для решти — `respond(context, result)` у `controllers/shared/`: `isError` → `mapControllerError`, інакше `result.value`.

- Типи `*Response` у `shared/responses` за потреби спростити, щоб helper вписувався без кастів.
- Методи з додатковою логікою (`changePassword`, `resetPassword`, `startPhonePasswordReset`) переписати під helper, якщо це їх спрощує. Наприклад, `resetPassword` вручну фільтрує `reason`, а це можна перенести в сервіс.

Етап можна об'єднати з відповідним PR етапу 4.

## Етап 6 — стан сесії (🟢, необов'язково)

[`session-handler.ts:151-446`](../../packages/backend/src/vendor/utils/session/session-handler.ts) тримає три змінні стану в замиканні (`sessionInfo`, `cookieHeld`, `contextUserToken`) і 4 модульні `WeakMap`/`WeakSet`.

**Зміна.** Винести стан у клас `RequestSession` з явними переходами (`anonCookie → stored`, `login`, `logout`). Замість трьох перезаписів `beforeSend` — одне поле для «що зробити перед відправкою».

**Обережно.** Код чутливий до race conditions (ADR 0002, `anonymous-session-flood-plan.md`). Страховка — наявні тести: `session-revocation*.pg.test.ts`, `csrf-bootstrap.redis.test.ts`, `redis-session-storage.spec.ts`. Публічний API `context.session` / `context.auth` можна змінювати, якщо це спрощує код. Але гарантії проти race conditions мають лишитися, і кожну зміну поведінки покриває тест.

## Етап 7 — прибрати код сумісності (🟡)

Перехідні механізми, які мали сенс лише для вже розгорнутих клієнтів:

- **Фолбек на старий cookie сесії.**
    - Ланцюжок, який треба видалити: [`resolve-session-cookie.ts`](../../packages/backend/src/vendor/utils/session/resolve-session-cookie.ts) повертає `source: 'legacy'`, [`delete-legacy-session-cookie.ts`](../../packages/backend/src/vendor/utils/session/delete-legacy-session-cookie.ts) видаляє старий cookie, у [`session-web.ts`](../../packages/backend/src/vendor/utils/middlewares/ws/session-web.ts) є гілка `legacy`, а в `sessionHandler` — параметр `forceCookie`. Читати тільки активне ім'я cookie.
    - Саме ім'я `uapi` у `config/session.ts` лишається: його використовують без `__Host-` префікса (HTTP у локальній розробці). Перейменувати константу з `LEGACY_COOKIE_NAME` на `PLAIN_COOKIE_NAME` і прибрати `legacyCookieName` з конфігурації.
- **`LegacyLoginInputSchema`** у [`shared/src/schemas/auth/login.ts`](../../packages/shared/src/schemas/auth/login.ts). Frontend надсилає тільки `identifier`. Залишити одну схему й перевірити `api-playground`, seed-скрипти, e2e і документацію на варіант з `email`.
- **Аліас `routeItem`** у [`types.d.ts:335`](../../packages/backend/src/vendor/types/types.d.ts). У коді його використовує лише `routeList`, тож скрізь писати `RouteItem`.
- Перед PR ще раз пошукати `legacy`, `backward`, `deprecated` у `packages/*/src` і для кожного знайденого вирішити, прибрати його чи лишити (наприклад, `serialize-ark-schema.ts:36`).

**Документація.** [`auth.md`](../../documentation/backend/auth.md) / [`security.md`](../../documentation/backend/security.md): прибрати опис міграції cookie; [`configuration.md`](../../documentation/backend/configuration.md), якщо там згадано legacy-ім'я.

## Перевірка завершення (для кожного етапу)

- Цільові тести етапу, потім `pnpm typecheck`, `pnpm lint`, `pnpm test`. Для етапів 4 і 6 — також `test:pg` і Redis-набори.
- `pnpm docs:build && pnpm docs:verify`, якщо змінено `documentation/`.
- Ручна перевірка:
    - **етап 1:** зупинити MinIO/S3 → `POST` аватара → 500 і запис `error` з `requestId` у лозі. Зупинити Redis → кілька запитів → у лозі `error` на кожен, а в Sentry лише одна подія `Redis unavailable` від `redis-health`;
    - **етап 2:** надіслати в WS `{not json` → `bad_request`, у лозі `warn`, у Sentry нічого. Зупинити Redis → WS-запит → `service_unavailable`, HTTP-запит → 503 з `Retry-After: 1`;
    - **етап 3b:** збій login-сесії → рівно один запис `error`;
    - **етап 4:** login з невірним паролем → 401 як раніше. Зупинити PostgreSQL → login → 500 з логом. Зупинити rate-limit Redis → login → 503 без події в Sentry;
    - **етап 7:** login через frontend → cookie лише з активним ім'ям. Запит зі старим `uapi` при ввімкненому `__Host-` префіксі → анонімна сесія, без помилки.
- Пропущені команди записувати як неперевірені в `progress.md`; не заявляти Definition of Done без них.
