# План: feat-275 — прибирання у vendor (мертвий код, `setHeader`, ключі статики, імпорти)

Дата: 2026-11-27 (редакція 2, після рев'ю)

## Проблема

Аналіз `packages/backend/src/vendor` знайшов шість дрібних проблем. Дефектів, які проявляються
зараз, серед них немає, але кожна з них — пастка для наступних змін:

1. `start/validators.ts` — порожній `Map<string, ValidatorFunction>`, залишок старої схеми
   валідації WS. Ніде не імпортується.
2. `isValidUrl` (`http-request-handlers.ts`) експортується, але ніде не викликається, навіть у
   тестах. Перевіряє лише `//`, тож створює хибне враження, що URL десь перевіряють.
3. `ResponseData.setHeader` (`response-data.ts`) робить `headers.push(...)`. Назва обіцяє
   «встановити» (як `res.setHeader` у Node, що замінює значення), а повторний виклик з тим самим
   ім'ям дає два однакові заголовки.
4. `parseMultipart` створює `new TextDecoder()` на кожну не-файлову частину.
5. Ключ кешу статики — `filePath.substring(STATIC_PATH.length)` (`static-server.ts:140`): на
   Windows це `\assets\x.js`, і ні `cache.get('/index.html')`, ні пошук за URL не спрацьовують.
6. Неоднорідні імпорти у vendor: `'crypto'` без `node:`, `#logger` поряд з
   `#vendor/utils/logger.js`, відносні `../` поряд з `#vendor/*`. Лінтер цього не ловить.

## Рішення

Одна фіча, шість незалежних кроків, кожен — окремий коміт. Поведінка API не змінюється: це
підтверджують наявні тести і тести, додані для `setHeader` і ключів статики.

- **`setHeader` замінює значення** заголовка з тим самим ім'ям (без урахування регістру).
  `appendHeader` **не** додаємо: зараз жоден виклик не потребує кількох значень одного заголовка
  (див. «Факти з коду»), а `Set-Cookie` має окремий шлях (`setCookie`). Якщо такий заголовок колись
  знадобиться (`Link`, `Vary`), це окремий `feat-XXX`.
- **Стиль імпортів закріплюємо лінтером**, а не лише ручною правкою, інакше він знову розповзеться.
  Нових залежностей не додаємо (`eslint-plugin-unicorn` / `eslint-plugin-import` у репо немає):
  достатньо вбудованого `no-restricted-imports`.

## Факти з коду

- **`validators.ts`.** Єдине згадування — закоментовані рядки `ws-api-dispatcher.ts:2`
  (`// import validators ...`) і `:9` (`// ValidatorFunction,`). Тип `ValidatorFunction`
  (`types/types.d.ts:17`) використовує лише `validators.ts`. Збіги в `static-server.spec.ts:78` і
  `serialize-routes.spec.ts:165` — лише слово «validators» у назвах тестів, до цього файлу вони
  стосунку не мають.
- **`isValidUrl`.** Визначення `http-request-handlers.ts:298-301`, експорт `:344`. Викликів немає ні
  в `packages/`, ні в документації. Небезпечні URL статики відсікає власний `isUrlSafe`
  (`static-server.ts`), маршрути API — роутер uWS і `validateParameter`.
- **Хто викликає `setHeader`** (production-код):
    - `http-rate-limit.ts:33-38` (`writeRateLimitHeaders`) — `X-RateLimit-Limit/Remaining/Reset`.
      Її викликає `consumeOrReject` (`:78-80`) для **обох** лімітерів: ліміт маршруту
      (`checkRateLimit`, `'always'`) пише їх завжди, глобальний (`checkGlobalRateLimit`, L1,
      `'on-reject'`) — лише коли відмовляє. `rejectRateLimited` (`:55`) в обох випадках додає
      `Retry-After`;
    - в одній відповіді обидва набори не зустрічаються лише завдяки короткому замиканню `&&` у
      `server.ts:522-524` (`checkGlobalRateLimit(...) && checkRateLimit(...)`): після 429 від L1
      ліміт маршруту не виконується. Отже, джерел 429 два, і перевіряти треба обидва;
    - `apply-service-status.ts:10` — `Retry-After` з контролера. Після 429 від будь-якого лімітера
      контролер не виконується;
    - `oauth-controller.ts:66,128,222`, `support-controller.ts:75` — `Location`, по одному разу.

    Отже, заміна замість `push` не повинна змінити поточні відповіді, але це **зміна контракту**
    `setHeader` (див. крок 2), а не лише рефакторинг. `hasHeader`
    (`http-response-handlers.ts:21`) уже порівнює імена без урахування регістру. `server.ts:322`
    очищує `responseData.headers` перед відповіддю про помилку — це не змінюється.
    CSP контролера (`security.md:216`) може йти під двома різними іменами
    (`Content-Security-Policy`, `…-Report-Only`) — це різні заголовки, заміна їх не зачіпає.

- **Тести лімітера не бачать контракт `setHeader`.** `http-rate-limit.spec.ts:33-44` будує
  власний `ResponseData` з `setHeader`, що робить `push`, а не `createResponseData`. Тест
  «fires before the route limit and describes itself on 429» (`:183`) перевіряє набір L1 саме
  через цей мок, тож зміна в `response-data.ts` на ці тести не вплине.

- **`TextDecoder`.** `http-request-handlers.ts:233-234`, усередині циклу по частинах multipart.
  Успішне декодування кількох текстових полів зараз не перевіряє жоден тест: `http-body-limits`,
  `upload-limits.transport`, `security-regressions` перевіряють ліміти і відмову на невалідній
  формі, а `http-request-handlers.spec.ts` мокає `getParts`. Контракт аватара
  (`contract-schemas/avatar.ts:7`) має `EmptyFormInputSchema`, тобто текстових полів не приймає.
- **Ключі статики.** `STATIC_PATH = path.join(process.cwd(), './public' | './public-test')`
  (`static-server.ts:19-22`). Статику бекенд віддає лише при `SERVE_STATIC=true`
  (`config/app.ts:60`, типово `false`); `make dev` запускає окремий Vite-сервер, тож кеш бекенду
  в dev не задіяний. Production-подібний запуск — `make prod-local` (`scripts/prod-local.sh`).
  Ключ і `STATIC_PATH` будуються від однієї бази, тож залежність від
  `cwd` — питання конфігурації, а не ключа. Ключі читаються як URL: `cache.get('/index.html')`
  (`:195`, `:446`), пошук за `req.getUrl()`. `cacheFile` уже експортується (`:464`).
- **Імпорти у vendor (production-код, без `*.spec.ts` / `*.test.ts`):**
    - `'crypto'` — `utils/context/http-context.ts:4`, `utils/context/ws-context.ts:5`. В інших
      пакетах голих built-in немає;
    - `#logger` — лише `utils/storage/s3.ts:9` (решта vendor: 24 імпорти через
      `#vendor/utils/logger.js`). Поза vendor `#logger` — звичайний аліас проєкту, його не чіпаємо;
    - `../` — `types/types.d.ts:6-8`, `start/server.ts:26,63`, `utils/network/ws-handlers.ts:3,19`,
      `utils/network/errors/unsupported-media-type-error.ts:2`,
      `utils/routing/ws-api-dispatcher.ts:13-14`, `utils/rate-limit/rate-limit-store.ts:3`.
      Ще `./` в одному каталозі (наприклад `./logger.js`) — це нормально і лишається.
- **ESLint (`eslint.config.ts`).** Блок `:163` для `packages/backend/src/**/*.ts` (без тестів)
  уже має `no-restricted-imports` (`paths`: `define-raw-route`, `define-ws-route`, ADR 0005/0006).
  У flat config пізніший блок з тим самим правилом для тих самих файлів **замінює** опції правила
  повністю, а не дописує їх. Окремий блок «тільки для vendor» з `no-restricted-imports` мовчки
  вимкнув би заборону `define-raw-route` у vendor.
- **Моки в тестах.** У vitest `#logger` і `#vendor` — аліаси на `src/vendor/...`
  (`vitest.config.ts:26,29`), моки зіставляються за розв'язаним шляхом. `s3.spec.ts:15` мокає
  `'#logger'`; після заміни імпорту в `s3.ts` мок має розв'язатися в той самий файл — перевірити
  прогоном, а за потреби перевести мок на `'#vendor/utils/logger.js'`.

## 0. Підготовка (`AGENTS.md`)

1. PR у `main` з короткої гілки `chore/feat-275-entry`: запис `feat-275` у `feature_list.json`
   (наступний вільний id після feat-274; `in_progress`, owner, branch `chore/vendor-cleanup`,
   dependencies `[]`) і цей план. Merge commit після зелених перевірок.
2. Гілка `chore/vendor-cleanup`, файл `feature-state/feat-275/progress.md`, `./init.sh` —
   переконатися, що база зелена.

## 1. Мертвий код

- Видалити `packages/backend/src/vendor/start/validators.ts`.
- `utils/routing/ws-api-dispatcher.ts`: прибрати закоментовані рядки 2 і 9.
- `types/types.d.ts:17`: прибрати `ValidatorFunction` (перед цим `grep` по репо, включно з
  `documentation/` і `packages/backend/README.md`, — зараз збігів немає).
- `utils/network/http-request-handlers.ts`: прибрати `isValidUrl` і його ім'я з експорту.
- `pnpm typecheck` і `pnpm lint` підтверджують, що споживачів немає.

## 2. `setHeader` замінює значення

`utils/network/response-data.ts`:

```ts
const setHeader: ResponseData['setHeader'] = (name: string, value: string): void => {
    const lower = name.toLowerCase()
    const existing = headers.find((header) => header.name.toLowerCase() === lower)
    if (existing !== undefined) existing.value = value
    else headers.push({ name, value })
}
```

- Ім'я першого виклику зберігається (порядок і регістр заголовків у відповіді не змінюються).
- JSDoc над `setHeader` у `ResponseData` (`types/types.d.ts`): «Ставить заголовок; повторний
  виклик з тим самим ім'ям (без урахування регістру) замінює значення. Cookie — через
  `setCookie`.»

**Тести** — `utils/network/response-data.spec.ts`, новий `describe('setHeader')`:

- один виклик → один запис `{ name, value }`;
- два виклики з тим самим ім'ям → один запис з другим значенням;
- `Retry-After` і `retry-after` → один запис, ім'я першого виклику;
- різні імена → обидва записи в порядку викликів.

**Тести лімітера на реальному `createResponseData`** (`http-rate-limit.spec.ts`): замінити
локальний мок `createResponseData` (`:33-44`) на `createResponseData` з
`#vendor/utils/network/response-data.js` (мок `#config/cookies.js` за потреби) і явно покрити
обидва джерела 429 через `check(...)`, який повторює порядок `server.ts`:

- **L1 відмовляє** (глобальний ліміт вичерпано, ліміт маршруту є): `passed === false`, рівно
  один `Retry-After` і рівно по одному `X-RateLimit-Limit/Remaining/Reset` зі значеннями L1
  (`limit = 3`, `remaining = 0`); ліміт маршруту не писав нічого (немає `X-RateLimit-Limit: 100` маршруту поряд з `3` від L1);
- **ліміт маршруту відмовляє** (L1 пропускає): рівно один `Retry-After` і по одному
  `X-RateLimit-*` зі значеннями маршруту;
- **успіх**: по одному `X-RateLimit-*` маршруту, `Retry-After` немає (наявний тест `:195`).

Ці тести мають бути зеленими і до, і після зміни `setHeader`: вони фіксують, що одиничність
заголовків тримається на порядку перевірок, а не лише на заміні.

Інші наявні тести (`upgrade-rate-limit.spec.ts`, CSP
(`server-csp.spec.ts`) і контролерів, що перевіряють `setHeader`, мають лишитися зеленими без змін.
Якщо якийсь тест очікує два однакові заголовки — це знахідка: зупинитися і записати її в
`progress.md`, а не підганяти тест.

## 3. `TextDecoder` у multipart

`utils/network/http-request-handlers.ts`: один `const utf8Decoder = new TextDecoder()` на рівні
модуля, у циклі — `utf8Decoder.decode(part.data)`. Опції декодера ті самі, тож поведінка (заміна
невалідного UTF-8 на U+FFFD) не змінюється.

**Тест** (зараз успішне декодування полів не покрите, див. «Факти з коду»): новий
`utils/network/multipart-parse.spec.ts` **без** мока `uWebSockets.js` (справжній `getParts`).
`parseMultipart` додати до блоку експортів з коментарем «exported for tests». Тіло будувати через
`multipartBody` з `test-support/raw-http.ts`. Один кейс: два текстові поля з Unicode
(`'Привіт, світ'`, `'emoji 👋 ünï'`) і один файл → `payload` дорівнює точно
`{ a: 'Привіт, світ', b: 'emoji 👋 ünï' }`, файл — у `files`, не в `payload`. Тест пишеться
першим і має бути зеленим до і після заміни декодера.

## 4. Ключі кешу статики

`start/static-server.ts`:

```ts
/** Cache key of a file under the static root: a URL path (`/assets/a.js`) on every OS. */
const toCacheKey = (root: string, filePath: string, p: path.PlatformPath = path): string =>
    '/' + p.relative(root, filePath).split(p.sep).join('/')
```

- `cacheFile`: `const key = toCacheKey(STATIC_PATH, filePath)` замість `substring`.
- Експорт — **лише** через наявний блок `export { … }` (`:462`), як решта модуля; без
  `export const`.

**Тести** — `start/static-server.spec.ts` (або `static-server-caching.spec.ts`):

- POSIX: `toCacheKey('/srv/public', '/srv/public/assets/a.js', path.posix) === '/assets/a.js'`;
  `/srv/public/index.html` → `/index.html`;
- Windows: `toCacheKey('C:\\app\\public', 'C:\\app\\public\\assets\\a.js', path.win32)` →
  `/assets/a.js`.

Наявні тести кешування (`static-server*.spec.ts`) працюють з реальними ключами на `public-test` і
мають лишитися зеленими.

## 5. Імпорти: код у vendor, правило `node:` на весь бекенд

**Правки коду:**

- `http-context.ts:4`, `ws-context.ts:5`: `'crypto'` → `'node:crypto'`.
- `utils/storage/s3.ts:9`: `'#logger'` → `'#vendor/utils/logger.js'`; прогнати `s3.spec.ts`
  (див. «Моки в тестах»).
- Усі `../` з «Фактів з коду» → `#vendor/...` з тим самим файлом (наприклад
  `'../routing/ws-api-dispatcher.js'` → `'#vendor/utils/routing/ws-api-dispatcher.js'`).
  Відносні `./` в одному каталозі не чіпаємо.

**ESLint** (`eslint.config.ts`), без нових залежностей.

**Область — свідоме рішення.** Заборона голих built-in (`'crypto'` замість `'node:crypto'`)
ставиться в наявний блок `:163`, тобто діє на весь `packages/backend/src` (без тестів), а не лише
на vendor: поза vendor порушень нуль, тож ціна нульова, а правило «тільки у vendor» лишило б
`src/app` і `src/database` без захисту. Заборони `#logger` і `../` — лише для vendor.

Зміни:

- винести поточні `paths` блоку `:163` у константу `BACKEND_RESTRICTED_IMPORT_PATHS`;
- додати до неї записи для built-in модулів без префікса, згенеровані з
  `builtinModules` (`node:module`), без тих, що вже мають `node:`: повідомлення «Import Node
  built-ins with the node: prefix»;
- новий блок для `packages/backend/src/vendor/**/*.ts` (без тестів) з **тим самим** списком
  `paths` (інакше заборона `define-raw-route` для vendor зникне, див. «Факти з коду») плюс:
    - `paths`: `#logger` → «Inside vendor import #vendor/utils/logger.js»;
    - `patterns`: `{ group: ['../*'], message: 'Inside vendor import through #vendor/*' }`;
- коментар над блоком з посиланням на feat-275 і поясненням, чому `paths` повторюється.

**Негативна перевірка правил** (тимчасові правки, потім відкотити; вивід `pnpm lint` — у
`progress.md`). Кожна має впасти з відповідним повідомленням:

1. `'crypto'` у файлі vendor і `'fs'` у файлі `src/app` — заборона built-in на весь бекенд;
2. `../` і `#logger` у файлі vendor;
3. **ADR-заборони збереглися у vendor:** імпорт `#app/routing/define-raw-route.js` і
   `#app/routing/define-ws-route.js` у файлі vendor (наприклад `start/server.ts`);
4. те саме в файлі `src/app` (поза vendor) — блок `:163` не зламано.

Без пунктів 3–4 перевірка не доводить, що новий vendor-блок не перекрив старі `paths`.

Тести (`*.spec.ts`, `*.test.ts`) під правило не потрапляють: у них `../../../test-support/...` і
`vi.mock('#logger')` — свідомий стиль, змінювати його поза обсягом.

## 6. Документація (обидві мови: `documentation/` і `documentation/en/`)

- `backend/controllers.md:132` (таблиця `responseData`): «Додає заголовок відповіді» → «Ставить
  заголовок відповіді; повторний виклик з тим самим ім'ям замінює значення (без урахування
  регістру). Cookie — через `setCookie`».
- `guide/http-response.md:222`: рядок «Додати заголовок» → «Поставити заголовок» (той самий
  приклад).
- `backend/security.md:216` — зміст лишається правильним, перевірити лише формулювання.
- Нових сторінок немає. `pnpm docs:build && pnpm docs:verify`.
- `validators.ts`, `isValidUrl`, ключі статики і стиль імпортів у публічній документації не
  згадуються — змін не потрібно (перевірено `grep`).
- `backend-feature` / `adding-a-feature.md` не стосуються: шари і патерни маршрутів не змінюються.

## 7. Перевірка і завершення

- `make check` (format, typecheck, lint, bundle graph, test).
- `make test-pg` і `make test-redis` не потрібні за обсягом (DB і Redis код не змінюється), але
  `rate-limit-store.ts` змінює лише імпорт; CI-джоби `test-pg` / `test-redis` на PR усе одно
  мають бути зеленими, посилання — в evidence.
- `pnpm docs:build && pnpm docs:verify`.
- Ручна перевірка основного сценарію:
    1. **Статика — через `make prod-local`** (бекенд сам віддає зібраний SPA; у `make dev` кеш
       бекенду не задіяний, див. «Факти з коду»):
        - `curl -i <origin>/` і `curl -i <origin>/some/deep/path` → `200`, HTML з кешу
          `/index.html`;
        - `curl -i <origin>/assets/<файл>.js` → `200` з `ETag`; потім
          `curl -i -H 'If-None-Match: <отриманий ETag>' <origin>/assets/<файл>.js` → `304` з тим
          самим `ETag`. Без явного `If-None-Match` `304` не перевіряється;
    2. **429 з обох джерел** (`curl -i`, тимчасово знижені ліміти в `.env`):
        - L1: `HTTP_GLOBAL_RATE_LIMIT_MAX=3`, четвертий запит → `429`, один `Retry-After`, по
          одному `X-RateLimit-*` зі значеннями L1;
        - ліміт маршруту: повернути L1, вичерпати маршрут з власним `rateLimit` → `429`, один
          `Retry-After`, по одному `X-RateLimit-*` маршруту;
    3. OAuth або support-редирект: один `Location`;
    4. multipart: завантаження аватара проходить (`200`, новий аватар). Декодування текстових
       полів перевіряє тест кроку 3, а не цей сценарій: контракт аватара полів не приймає.
- Evidence — у `feature-state/feat-275/progress.md`, далі `review` → merge → «Mark feat-275 done».

## Поза обсягом

- `appendHeader` для заголовків з кількома значеннями — немає споживача.
- Стиль імпортів у тестах і поза vendor (`#logger` в `src/app`, `src/database` — штатний аліас).
- Залежність `STATIC_PATH` від `process.cwd()` — це конфігурація, а не ключ кешу; окрема
  змінна оточення для кореня статики — окремий `feat-XXX`, якщо знадобиться.
