# План: прогалини лімітів тіла запиту (п. 14)

> **Статус:** виконано у feat-008, п. 14 (PR #46, merge `8ee410b`, 2026-10-23). `src/docs/HTTP_BODY_LIMITS_PLAN.md` згодом перенесено в [`http-body-limits-original-plan.md`](./http-body-limits-original-plan.md) (feat-009).

Пункт 14 з [`code-issues-found-during-docs.md`](./code-issues-found-during-docs.md). Фіча: **feat-008 «HTTP Body Fixes»** (разом із п. 12 і 13, обидва зроблено).
Шляхи відносно `packages/backend/`, якщо не вказано інше. Початковий план лімітів — `src/docs/HTTP_BODY_LIMITS_PLAN.md`.

## Проблема

Ліміти за типом тіла, 413, ранній відказ за `Content-Length` і обрив читання вже реалізовано. Пункт 14 перелічує, що лишилося:

| Прогалина                                                                     | Стан                                                                                                             |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| unit-тести `detectBodyKind` / `resolveMaxBodySize`, інтеграційні тести на 413 | **немає жодного**                                                                                                |
| `APP_MAX_*_BODY_SIZE` у `.env.example`                                        | **уже є** (feat-006, п. 6); значення збігаються з `src/config/app.ts` і `documentation/backend/configuration.md` |
| ліміти в playground через `serializeRoutes`                                   | **немає**                                                                                                        |
| defaults: код 2 / 50 / 50 / 2 MB, план 1 / 50 / 100 / 1 MB                    | розбіжність не вирішено                                                                                          |

### Як працює зараз

- `detectBodyKind` (`src/vendor/utils/network/http-request-handlers.ts`): `json` (лише `application/json` з необов'язковими параметрами, `application/json-patch+json` → `other`), `multipart`, `urlencoded`, `text`, `octet`, `other`.
- `resolveMaxBodySize`: `json` → `maxJsonBodySize`, `multipart` → `maxMultipartBodySize`, `octet` → `maxOctetStreamBodySize`, решта → `maxBodySize`. Значення з `parseSize` у `src/config/app.ts` (нечислове чи ≤ 0 → default).
- `readAndParseBody` (`src/vendor/start/server.ts`): якщо `Content-Length` відповідає `/^\d+$/` і більший за ліміт → `PayloadTooLargeError` → **413** без читання тіла.
- `readData`: сумує чанки `res.onData` і кидає `PayloadTooLargeError`, щойно сума **перевищить** ліміт (тіло рівно в ліміт проходить). Захищає від chunked-тіл і неправдивого `Content-Length`.
- `handleError`: 413 з `{ code: "payload_too_large", details: { kind: "payload_too_large", limit, contentType } }`.

### Пробіли в `Content-Length` — не проблема

`getHeaders` (`http-request-handlers.ts`) кладе в `meta.headers` значення після `value.trim()`, а `collectRequestMetadata` бере заголовки саме звідти. Тому `" 999"` до раннього відказу доходить як `"999"`, і обходу немає. Окремий `trim()` у ранньому відказі не потрібен (як і в `hasBodyFraming`, де він лише страхує прямий виклик). Тест із `" 999"` лишається як регресійний: він проходить і до змін.

### `readData` не закриває з'єднання

При перевищенні ліміту `readData` відхиляє Promise і перестає обробляти чанки, але з'єднання явно не закриває. Що бачить клієнт, який ще надсилає тіло (413 одразу чи після кінця тіла, зависання), з коду не видно — це має встановити тест на справжньому uWS (крок 4). Якщо 413 не доходить до кінця надсилання або з'єднання зависає, виправлення (наприклад, `Connection: close` у 413 і закриття після відповіді) додається в цей же пункт.

### `parseSize` приймає зайве

`parseSize` (`src/config/app.ts`) відкидає лише `NaN` і `≤ 0`, тож `"Infinity"` вимикає ліміт, а `"1.5"` дає дробовий ліміт.

### Реальні розміри

- `octet`-маршрутів немає.
- `multipart` — два маршрути (`src/app/routes/http-routes.ts`): аватар (`MAX_FILE_SIZE` 10 MB в `avatar-service.ts`) і скриншот бази знань (`MAX_SCREENSHOT_SIZE` 5 MB у `knowledge-base-service.ts`).
- Великих JSON-тіл у фронтенді не знайдено (base64 лише для ключа push-підписки).
- WS-ліміт — `maxPayloadLength: 1 MB` у `server.ts`, поза обсягом.

## Рішення

### Defaults

Лишаємо значення з коду і фіксуємо їх як рішення:

| Змінна                        | Default | Чому                                                                                                                                |
| ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `APP_MAX_JSON_BODY_SIZE`      | 2 MiB   | реальні JSON-тіла значно менші; зниження до 1 MiB — зміна без вигоди                                                                |
| `APP_MAX_BODY_SIZE` (решта)   | 2 MiB   | так само, для `urlencoded`, `text`, `other`                                                                                         |
| `APP_MAX_MULTIPART_BODY_SIZE` | 50 MiB  | політика сумісності: зміна не дає вигоди; фактична потреба — файлові ліміти сервісів (10 MB, 5 MB) плюс невелика multipart-обгортка |
| `APP_MAX_OCTET_BODY_SIZE`     | 50 MiB  | `octet`-маршрутів немає; 100 MiB з плану не має обґрунтування                                                                       |

`src/docs/HTTP_BODY_LIMITS_PLAN.md` отримує примітку, що defaults 1 / 50 / 100 / 1 MB замінено цим рішенням (посилання на цей план). Застереження про проксі (`client_max_body_size` ≥ ліміту) і **приблизну оцінку буферів** `≈ concurrent × maxMultipartBodySize × 2` переносимо. Це оцінка лише буферів тіла, а не верхня межа пам'яті процесу: парсери ще створюють рядки, об'єкти й копії даних. **Оновлення 2026-11-13 (feat-201, security review M-3):** кількість одночасних запитів нічим не обмежувалась, а тіло читається до автентифікації; тепер буфери тіл обмежує бюджет «у польоті» (`APP_MAX_INFLIGHT_BODY_BYTES`, `APP_MAX_INFLIGHT_BODY_BYTES_PER_IP`), тож оцінка стала `≤ APP_MAX_INFLIGHT_BODY_BYTES × 2`. Переносимо в `documentation/backend/configuration.md`, якщо їх там ще немає.

### `parseSize`

Допустиме значення — **додатне безпечне ціле число** байт (`Number.isSafeInteger(n) && n > 0`, рядок лише з цифр). `"Infinity"`, `"1.5"`, `"1e6"`, `"abc"`, `"0"`, `"-1"` → default. Це **зміна поведінки**: раніше `Infinity` і дробові значення приймались. Тестується через env і повторний імпорт `#config/app.js` (`vi.resetModules()`), без експорту helper'а.

### Ліміт у playground

`serializeRoutes` (`src/vendor/utils/routing/serialize-routes.ts`) додає до маршруту з тілом (`post`/`put`/`patch`, `isBodyMethod`) поле `bodyLimits`: для кожного типу з `allowedContentTypes ?? ["json"]` — `{ kind, maxBytes: resolveMaxBodySize(kind) }`. Маршрути без тіла поле не мають. Ліміт залежить від `Content-Type` запиту, а не від маршруту, тому це список, а не одне число.

`allowedContentTypes: []` (будь-який `Content-Type` дає 415) → `bodyLimits: []`, і playground пише «Немає дозволених типів тіла». Не «тіло не приймається»: запит без `Content-Type` такий маршрут пропускає (`payload: null` без `validator`, валідація `{}` з `validator` і без framing — `readAndParseBody`, `server.ts`). WS-маршрути поля не мають.

`packages/api-playground`: тип `ApiRoute` (`src/stores/api-doc.ts`) отримує `bodyLimits?`, а `src/components/api/ApiRoute.vue` показує його в блоці з middleware і rate limit (форматування в MiB/KiB, як `formatRateLimit` для лімітів частоти). Умова напису «No additional details» доповнюється `!route.bodyLimits`, інакше він лишиться поруч із лімітами.

Ендпоінт `/<pathPrefix>/doc/routes` доступний лише при `APP_ENV=manual-test` і `docPage`, тож розкриття лімітів назовні не розширюється.

## Кроки

1. **`parseSize`**: додатне безпечне ціле число, інакше default (див. рішення).
2. **Unit-тести** у двох файлах, щоб підмінена й справжня конфігурація не змішувались.

    `src/vendor/utils/network/http-request-handlers.spec.ts` (новий, з моком `#config/app.js`):
    - `detectBodyKind`: `application/json` → `json`; `application/json; charset=utf-8` → `json`; `APPLICATION/JSON` → `json`; `application/json-patch+json` → `other`; `multipart/form-data; boundary=x` → `multipart`; `application/x-www-form-urlencoded` → `urlencoded`; `text/plain` → `text`; `application/octet-stream` → `octet`; `""` → `other`;
    - `resolveMaxBodySize`: кожен `BodyKind` → відповідне поле `config` (через мок `#config/app.js` з різними значеннями, щоб тест бачив, яке поле взято).

    `src/config/app.spec.ts` (новий, справжній `#config/app.js`, без моку): `vi.resetModules()` і динамічний імпорт у кожному тесті, `APP_MAX_JSON_BODY_SIZE` задається через `process.env` і відновлюється в `afterEach` (видаляється, якщо його не було):
    - `parseSize`: `"1024"` → 1024; `"abc"`, `"0"`, `"-1"`, `"1.5"`, `"1e6"`, `"Infinity"`, `"9007199254740993"` → default. З кодом до кроку 1 падають `"1.5"`, `"1e6"`, `"Infinity"` (негативний контроль).

3. **Тести через зареєстрований HTTP-handler** (фейковий `uWebSockets.js` `App`, за зразком `src/vendor/start/http-body-methods.spec.ts`), новий `src/vendor/start/http-body-limits.spec.ts`, з маленькими лімітами через мок `#config/app.js` (наприклад, JSON 64 B, multipart 256 B, octet 512 B, загальний 32 B):
   Розміри рахуються через `Buffer.byteLength()`. Успішні JSON-тіла — валідні JSON-**об'єкти** (`readJson` відкидає рядки, масиви й `null`), доповнені до потрібної довжини полем-рядком.
    - JSON менше ліміту → 200;
    - **ранній відказ:** `Content-Length` = ліміт + 1 → 413 з `details.limit` і `details.contentType`, `onData` не викликано, handler не викликано; `Content-Length` = ліміт → не відхиляється рано;
    - **межа потокового читання** (без `Content-Length`, кількома чанками `onData`, з багатобайтовими символами, наприклад `"ї"` і `"😀"`): рівно ліміт байтів → 200; ліміт + 1 → 413. В успішному варіанті **межа між чанками розрізає байти одного багатобайтового символу** (наприклад, перші 2 з 4 байтів `"😀"` в одному чанку, решта в наступному), а склеєне тіло — повний валідний JSON-об'єкт рівно на ліміт байтів: handler отримує поле з цілим символом;
    - `Content-Length` менший за реальне тіло → 413 під час читання (неправдивий заголовок);
    - регресія: `Content-Length` з пробілами (`" 999"`) більший за ліміт → 413 без читання (вже працює завдяки `getHeaders`);
    - `octet` більший за JSON-ліміт, але менший за octet-ліміт → 200 (розділення лімітів);
    - `multipart` менше / більше ліміту → 200 / 413;
    - `text/plain` на маршруті з `allowedContentTypes: ["text"]` більший за загальний ліміт → 413 з `limit` загального ліміту.

    Негативний контроль: з тимчасово зміненим `resolveMaxBodySize` (усе → `maxBodySize`) тест розділення падає; з `totalSize >= limit` замість `>` у `readData` падає тест «рівно ліміт».

4. **Справжній uWS**, новий `src/vendor/start/http-body-limits.transport.spec.ts` за зразком `rate-limit.transport.spec.ts`, клієнт на сирому `net.Socket` (щоб керувати надсиланням):
    - `Content-Length` більший за ліміт, надіслано **лише заголовки** → клієнт отримує 413, не надсилаючи тіла;
    - chunked JSON, ліміт перевищено на **неостанньому** чанку, завершальний чанк не надсилається → клієнт отримує 413, не чекаючи кінця тіла;

    Очікування відповіді має власний таймер (наприклад, 2 с): Promise читання з сокета відхиляється, якщо відповідь не прийшла вчасно, тож `await` не зависає. У `finally` — `clearTimeout` і `socket.destroy()`. Успіх — отримано **повну** HTTP-відповідь 413: рядок статусу, заголовки і тіло довжиною з `Content-Length`, яке парситься як JSON з `code: "payload_too_large"`; одного рядка статусу недостатньо. Результат (чи доходить 413, чи закривається з'єднання) записується в `progress.md`; якщо поведінка неприйнятна — виправлення в `readData`/`handleError` у цьому ж пункті (див. «`readData` не закриває з'єднання»).

5. **`serializeRoutes`**: поле `bodyLimits`; тест у `src/vendor/utils/routing/serialize-routes.spec.ts`:
    - `post` без `allowedContentTypes` → `[{ kind: "json", maxBytes }]`;
    - `put` і `patch` → так само;
    - `allowedContentTypes: ["multipart"]` → `[{ kind: "multipart", … }]`;
    - кілька типів (`["json", "multipart"]`) → два елементи в тому ж порядку;
    - `allowedContentTypes: []` → `[]`;
    - `get`, `delete` і WS-маршрут → поля немає;
    - групи рекурсивно.
6. **Playground**: тип `bodyLimits?` в `ApiRoute`, рядок у `ApiRoute.vue`, оновлена умова «No additional details». Тестів у `api-playground` немає — `pnpm --filter api-playground build` і перевірка вручну.
7. **Документація** (в тому ж PR, за `AGENTS.md`):
    - `documentation/backend/request-lifecycle.md`, «Тіло запиту: типи і ліміти»: таблиця тип → змінна → default, межа «рівно в ліміт проходить», обробка `Content-Length` з пробілами;
    - `documentation/backend/configuration.md`: чому такі defaults, застереження про проксі й пам'ять;
    - `src/docs/HTTP_BODY_LIMITS_PLAN.md`: примітка про замінені defaults і зроблені тести;
    - `code-issues-found-during-docs.md`: п. 14 виправлено, `.env.example` закрито ще в feat-006.
8. **Перевірка:** `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm --filter api-playground build`, `pnpm docs:build && pnpm docs:verify`.
   Ручна перевірка на запущеному backend (`curl`):
    - JSON-об'єкт на ~3 MB (`{"email":"<3 MB 'a'>"}`) у `POST /api/auth/login` → 413 з `limit: 2097152`;
    - `curl -H 'Content-Type: application/json' -H 'Content-Length: 99999999' --data-binary '{}'` → 413 одразу (ранній відказ);
    - той самий великий файл через `Transfer-Encoding: chunked` → 413;
    - `POST /api/auth/login` з нормальним тілом → як раніше;
    - playground при `APP_ENV=manual-test`: на `POST /upload` видно `multipart: 50 MiB`, на `GET` — нічого і «No additional details» лише там, де деталей справді немає.

## Поза обсягом

- WS-ліміт `maxPayloadLength` (1 MB у коді, без env).
- Ліміти на рівні маршруту (`maxBodySize` у `defineRoute`): зараз ліміт лише за типом тіла.
- Суфікси розмірів у env (`10mb`): `parseSize` приймає лише ціле число байт, як вирішено в початковому плані.
- Поведінка при `res.onAborted` під час читання — лише вручну, як у початковому плані.
- Контракт `validator` для `octet`-маршрутів (з п. 12).

## Прийняті рішення

- Defaults лишаються 2 MiB (JSON і решта), 50 MiB (multipart), 50 MiB (octet); defaults 1 / 50 / 100 / 1 MB з `HTTP_BODY_LIMITS_PLAN.md` не застосовуються.
- `parseSize` приймає лише додатне безпечне ціле число байт; `Infinity` і дробові значення → default (зміна поведінки).
- Пробіли в `Content-Length` уже обрізає `getHeaders`; окремого виправлення немає, лише регресійний тест.
- Поведінку з'єднання після 413 на справжньому uWS встановлює тест; виправлення — лише якщо тест покаже проблему.
- Playground показує список `{ kind, maxBytes }` за `allowedContentTypes` маршруту, бо ліміт залежить від `Content-Type` запиту.
