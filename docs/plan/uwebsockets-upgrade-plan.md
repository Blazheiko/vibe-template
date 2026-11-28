# План: оновлення `uWebSockets.js` до ядра uWebSockets v20.81.0

Дата: 2026-11-27 (редакція 3.2: класи відмов уточнено пробою під час реалізації і рев'ю)

## Що саме оновлюємо

Тегу `v20.81.0` у репозиторії `uNetworking/uWebSockets.js` **немає**. `v20.81.0` — версія
C++-ядра `uNetworking/uWebSockets`. Його підключає реліз обгортки **`uWebSockets.js` v20.72.0**
(2026-11-24): PR [#1359](https://github.com/uNetworking/uWebSockets.js/pull/1359) «Bump
uWebSockets to v20.81.0» і [#1361](https://github.com/uNetworking/uWebSockets.js/pull/1361)
(master ядра з #1969 і #1972). Тому ціль у `package.json` така:

```json
"uWebSockets.js": "github:uNetworking/uWebSockets.js#v20.72.0"
```

| Що                     | Зараз                        | Ціль                                     |
| ---------------------- | ---------------------------- | ---------------------------------------- |
| Пакет `uWebSockets.js` | `v20.71.0` (`9ec36de`)       | `v20.72.0` (`c452ac24`)                  |
| `source_commit`        | `127ac80`                    | `42aee84`                                |
| Ядро uWebSockets       | `1d80f7a`                    | `05e6c8b` (v20.81.0 + #1969, #1972)      |
| ESM-точка входу        | `ESM_wrapper.mjs` + наш патч | `index.mjs` → `./index.js`, без патча    |
| `index.d.ts`           | —                            | без змін (діфу немає)                    |
| Бінарні ABI            | 127 / 137 / 147              | 127 / 137 / 147 (Node 24.22.2 = ABI 137) |

Проба на Node 24.22.2 (darwin-arm64) з тарболом `c452ac24` без патча: `import uWS from
'uWebSockets.js'` і `import * as uWS` працюють, `getParts` експортується, `App().listen()` і
`us_listen_socket_close()` відпрацьовують.

## Зміни апстріму і вплив на нас

### Обгортка `uWebSockets.js` (34 коміти між `source_commit`)

| Зміна                                                                                              | Вплив на нас                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1320, #1342, #1343: `uws.js` → `index.js`, `ESM_wrapper.mjs` → `index.mjs`, `exports` оновлено    | **Ламає наш патч.** `patches/uWebSockets.js@20.71.0.patch` і запис у `pnpm.patchedDependencies` прибрати. Виправляє [#1356](https://github.com/uNetworking/uWebSockets.js/issues/1356) |
| #1322: `us_listen_socket_close` / `us_socket_local_port` кидають виняток на не-сокет (був SIGSEGV) | `stopServer` (`vendor/start/server.ts:798`) уже перевіряє `listenSocket !== undefined` і обнуляє його, виклик у `try`. Поведінка лише безпечніша                                       |
| #1319: `listen('', port)` слухає саме `port`                                                       | Ми передаємо `appConfig.host`; якщо `HOST` порожній, раніше був би випадковий порт. Тепер коректно                                                                                     |
| #1357: `res.upgrade()` більше не мовчить при неповних аргументах                                   | `handleUpgrade` (`ws-handlers.ts:749`) передає всі 5 аргументів і вже ловить виняток з `releaseWsConnection`. Перевірити тестом upgrade                                                |
| #1325, #1330, #1331, #1333: `onAborted`/`onData`/`onWritable` у внутрішніх полях, менше handle-ів  | Семантика та сама («лише останній колбек»), на ній тримається `RequestAbortSignal` (`server.ts:488`). Покривається наявними тестами abort                                              |
| #1335, #1337–#1339, #1344, #1353, #1354: новий запис рядків у UTF-8 (`NativeString`)               | Найризиковіше місце: заголовки, тіла, `getParts`, `ab2str`. Перевіряють `header-values.live.spec.ts`, `multipart-parse.spec.ts`, transport-тести                                       |
| #1318: розмір масивів `getStringKeys`/`getIntegerKeys`                                             | Не використовуємо                                                                                                                                                                      |
| #1316, #1317: кешовані `get` на `H3App`                                                            | Не використовуємо (немає HTTP/3)                                                                                                                                                       |

### Ядро uWebSockets (20 комітів)

| Зміна                                                                                     | Вплив на нас                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #1951: 400 на request target з байтом поза видимим ASCII                                  | Сирий UTF-8 у шляху тепер 400 до нашого коду. Браузери і nginx кодують `%XX`, тож для клієнтів нічого не змінюється. Нова поведінка — задокументувати й закріпити тестом |
| #1949: 400 на `Host` з `/`, `?` або `#`                                                   | Посилення. Закріпити тестом                                                                                                                                              |
| #1969: 400 на `Content-Length` ≥ 2^56 (раніше тіло розбиралось як chunked — smuggling)    | Безпекове виправлення. Наш ліміт тіла (`http-body-limits`) спрацьовував би пізніше. Закріпити тестом                                                                     |
| #1950: трейлери після останнього chunk пропускаються, голий LF у них → 400                | Посилення парсера                                                                                                                                                        |
| #1952: `OPTIONS *` приймається                                                            | Доходить до `any('/*')` з `url = '*'` (перевірено на 20.72.0). Не `/api/`, тож L1 не рахується: з `ENABLED_CORS=true` — 200, інакше — 404. Деталі в кроці 2              |
| #1944: значення без `=` у query (`?debug&dx=5`)                                           | Ми не викликаємо `getQuery(key)`, лише `new URLSearchParams(req.getQuery())` (`server.ts:163`). Не впливає                                                               |
| #1972: після `close` через dropped PONG кадри більше не читаються (у uWS.js був segfault) | Ми не реєструємо `dropped`, але при flood PING з `maxBackpressure: 64 KiB` це робить сервер стійкішим                                                                    |
| #1955: вибір per-connection компресора                                                    | `compression: 0` (`server.ts:118`). Не впливає                                                                                                                           |
| `HttpCache`: `endWithoutBody`, `close`, статус і заголовки в кеші                         | Не використовуємо. Стосується [`future/http-microcache-plan.md`](./future/http-microcache-plan.md) — переглянути окремо, не в цій фічі                                   |
| #1947: сторінка 502; #1946, #1961, `cstdint`: збірка                                      | Не впливає                                                                                                                                                               |

**Висновок:** API (`index.d.ts`) не змінився, коду застосунку правити не треба. Обов'язкові зміни —
прибрати патч і посилання на `patches/`. Решта — нові відмови парсера (400), які треба закріпити
тестами й описати в документації.

## Кроки

Одна фіча (`feat-277`), гілка `chore/uws-20-72`. Кожен крок — окремий коміт.

Процес за `AGENTS.md`: спершу координаційний PR у `main`, що додає `feat-277` у
`feature_list.json` (`in_progress`, owner, branch); лише після його мерджу — гілка
`chore/uws-20-72` і `feature-state/feat-277/progress.md` на ній. Реалізаційна гілка
`feature_list.json` не редагує.

### 1. Версія і патч

- [ ] `packages/backend/package.json`: `#v20.71.0` → `#v20.72.0`.
- [ ] Корінь `package.json`: прибрати `pnpm.patchedDependencies` повністю (інших записів немає).
- [ ] Видалити `patches/uWebSockets.js@20.71.0.patch` і порожній каталог `patches/`.
- [ ] `Dockerfile:39–40` і `Dockerfile:128–129`, `packages/landing/Dockerfile:18–20`: прибрати
      `COPY patches ./patches` з коментарями — інакше `docker build` впаде на відсутньому каталозі.
- [ ] `pnpm install`; у `pnpm-lock.yaml` імпортер backend і пакет вказують на
      `codeload.github.com/uNetworking/uWebSockets.js/tar.gz/c452ac24524cac8eedc6c08b3025038c6e349712`
      без суфікса `(patch_hash=…)`, секції `patchedDependencies` немає.
      `pnpm install --frozen-lockfile` чистий.
- [ ] Встановлений пакет: `node -p "require('./packages/backend/node_modules/uWebSockets.js/package.json').version"`
      → `20.72.0`; у каталозі є `index.js`, `index.mjs`, немає `uws.js`.

### 2. Регресійні тести нової поведінки парсера

Новий файл `vendor/start/uws-parser.transport.spec.ts` за зразком
`http-body-limits.transport.spec.ts` і `upload-limits.transport.spec.ts`: справжній сервер, сирий
сокет через `test-support/raw-http.ts`. (`security-regressions.spec.ts` для цього не годиться: там
`App` замоканий.)

Як відповідає uWS на ці запити (перевірено пробою на 20.72.0): `HTTP/1.1 400 Bad Request`,
`Connection: close`, HTML-тіло **без** `Content-Length`, потім закриття сокета.

Що доводить тест, і чим:

- **Статус і заголовки** — `exchange()`. Без `Content-Length` `tryParse` вважає тіло порожнім і
  повертає відповідь одразу після заголовків, а потім сам знищує клієнтський сокет. Тому
  `exchange()` доводить лише рядок статусу й `Connection: close`, але **не** те, що сервер закрив
  з'єднання.
- **Закриття сервером** — окремий хелпер у `raw-http.ts` (наприклад, `exchangeUntilClose`):
  чекає подію `close` / `end` від сервера з таймаутом і повертає всі отримані байти як `Buffer`.
  Використовується там, де закриття є критерієм (усі відмови нижче).
- **Байти тіла** — `RawResponse` отримує `bodyBytes: Buffer` (зараз `body` декодується в рядок);
  UTF-8 і статика порівнюються з очікуваним `Buffer` через `Buffer.equals`, а не як рядки.

**Два класи відмов, документуються окремо** (проба на 20.72.0):

1. **Рядок запиту й заголовки** (non-ASCII target, `Host`, понад ~100 заголовків, керівний
   символ у значенні): 400 до виклику обробника, наш код не виконується.
2. **Під час читання тіла** (`Content-Length` ≥ 2^56, трейлери #1950). Уточнення під час
   реалізації: при `Content-Length` ≥ 2^56 uWS спершу викликає обробник, а потім, ще до тіла,
   робить `onAborted` і відповідає 400. Для `POST`/`PUT`/`PATCH` наш контролер не запускається,
   бо спрацьовує ліміт тіла; `GET` і `DELETE` тіла не читають, і їхній контролер виконується
   (рев'ю реалізації; перевірка `abortSignal.aborted` після читання тіла цього не змінює).
   Трейлери розбираються після тіла. Коли трейлер
   приходить окремим пакетом, обробник **уже викликаний**, `onData` віддав `last = true`, а
   клієнт усе одно отримує 400 від uWS і закриття. Тобто контролер міг відпрацювати (побічні
   ефекти), а його відповідь до клієнта не дійде. Тест фіксує це явно: сервер не падає, запис у
   відповідь після закриття не кидає необроблений виняток (`RequestAbortSignal` / `onAborted`), у
   лог немає `error`. Чи треба щось із цим робити, крім документування, — вирішити за
   результатом тесту, окремою фічею.

Якщо на Linux uWS закриє сокет до заголовків (RST), це баг, який треба розібрати, а не обходити в
хелпері.

- [ ] `GET /привіт HTTP/1.1` (сирі байти UTF-8) → 400; `GET /%D0%BF HTTP/1.1` доходить до роутера.
- [ ] `Host: localhost/path`, `Host: a?b`, `Host: a#b` → 400.
- [ ] `POST` з `Content-Length: 72057594037927936` → 400, обробник не викликається.
- [ ] Для всіх відмов класу 1: сервер закриває з'єднання (`exchangeUntilClose`), обробник не
      викликано (лічильник у тестовому маршруті).
- [ ] #1950: chunked-тіло з трейлером `X: y\r\n` після `0\r\n` проходить; трейлер з голим `\n` → 400.
      Два варіанти: усе одним пакетом і трейлер окремим пакетом після паузи — у другому
      зафіксувати, що обробник викликано і процес лишився живим (див. клас 2 вище).
- [ ] `OPTIONS * HTTP/1.1`:
    - `corsConfig.enabled = false` → 404 `not_found`;
    - `true` + `Origin` з `corsConfig` allowlist → 200 з `Access-Control-Allow-Origin` (= цей
      origin), `-Methods`, `-Headers`, `Vary: Origin`;
    - `true` + чужий `Origin` → 200 з `Vary: Origin`, але **без** `Access-Control-Allow-*`
      (`setCorsHeader` пише їх лише для дозволеного origin, `server.ts:761`).
    - Усе без L1, як і будь-який не-`/api/` `OPTIONS` зараз (наприклад, `OPTIONS /foo`), тож
      нового обходу rate limit немає. Фіксуємо поточну поведінку; обмеження preflight поза
      `/api/`, якщо знадобиться, — окрема фіча.
- [ ] Вихідний UTF-8 (`NativeString`, #1335–#1354): `res.end(JSON)` з кирилицею, 4-байтними emoji
      і сурогатними парами — тіло збігається побайтно, `Content-Length` дорівнює довжині в
      байтах; рядок довший за вільне місце в пулі (#1337, #1339) і порожній рядок (#1338);
      `ws.send()` з тим самим payload приходить без змін. Порівняння — `bodyBytes` проти
      очікуваного `Buffer.from(json, 'utf8')`.
- [ ] `onWritable` (#1325: колбек тепер у inline storage) на справжньому uWS: статичний файл
      значно більший за буфер сокета (наприклад, 8 MiB випадкових байтів) віддається клієнту, що
      спершу не читає (`socket.pause()`, потім `resume()` через ~200 мс). Перевірити, що
      `tryEnd` повернув «не влізло» (лічильник / spy на `onWritable`), запис відновився і клієнт
      отримав файл повністю: SHA-256 збігається, `Content-Length` = розмір файлу. Зараз
      `static-server-caching.spec.ts:86` перевіряє це лише на підставному `res`.
- [ ] Upgrade WS з валідною сесією проходить (уже є в `ws-registry-lifecycle.pg.test.ts` — переконатися,
      що він у прогоні `test-pg`).

Тест `header-values.live.spec.ts` (обрізання байтів > 0x7F на краях значення) **не змінювати**:
якщо новий `NativeString` змінив поведінку, тест упаде — тоді переглянути висновок feat-215 у
`docs/security/security-review-2026-11-12-follow-ups.md` і `header-checker.ts`, а не послаблювати тест.

### 3. Документація (обидві локалі в одному PR)

- [ ] `documentation/reference/toolchain.md` і `en/reference/toolchain.md`: розділ «Патч
      uWebSockets.js» прибрати (або замінити рядком: з `v20.72.0` патч не потрібен).
- [ ] `documentation/backend/index.md:15` і `en/…`: у таблиці стеку `v20.71.0` → `v20.72.0`.
- [ ] `documentation/backend/request-lifecycle.md` і `en/…` (транспортний контракт): новий
      розділ «Що uWS відхиляє сам» — 400 до нашого коду на non-ASCII у request target, `Host` з
      `/`, `?`, `#`, `Content-Length` ≥ 2^56, голий LF у трейлерах, понад ~100 заголовків,
      керівний символ у значенні; формат відповіді (HTML, `Connection: close`, без нашого JSON і
      CORS); `OPTIONS *`. Посилання на `uws-parser.transport.spec.ts`. У
      `guide/http-request.md` нічого не додаємо: це вступ до `context`.
- [ ] `documentation/backend/configuration.md:117` і `en/…`: «виміряно на uWS 20.71» про
      ~12 с для завислого тіла — переміряти на 20.72 і оновити, або лишити як датований вимір,
      якщо час не змінився.
- [ ] `vendor/utils/network/header-values.live.spec.ts:18`: коментар «(20.71.0)» → «(20.71.0,
      20.72.0)», якщо тест пройшов без змін.
- [ ] Контроль: `grep -rn "20\.71" documentation packages/backend/src` — лишаються тільки
      свідомі датовані виміри.
- [ ] Внутрішні `docs/` (технічна оцінка на `015bc2e7`, рев'ю, архів планів) — зрізи на коміт,
      не правимо.
- [ ] `pnpm docs:build && pnpm docs:verify`.

### 4. Перевірка (Definition of Done)

- [ ] `./init.sh` / `make check` зелений.
- [ ] `make test-pg` і `make test-redis` з виводом executed/skipped (багато `*.pg.test.ts` піднімають
      справжній uWS) або посилання на зелені `test-pg` / `test-redis` у CI.
- [ ] `pnpm --filter frontend test:e2e:live` (джоба `e2e-live` у `ci.yml`) на справжньому
      backend. Що саме покриває кожен прогін:
    - `playwright.live.config.ts` (`e2e-live/`): реєстрація, логін, сесії, ролі, нотифікації,
      WebSocket (`ws-close-after-logout.spec.ts`, `session-revocation.spec.ts`), MFA, passkeys;
    - `playwright.live-passkey.config.ts`: `staff-passkey-mode`, `reauth-step-up`;
    - `playwright.live-prefix.config.ts` (`API_PATH_PREFIX=v2/api`): **лише**
      `mfa-continuation.spec.ts` — тобто MFA-вхід під іншим префіксом, не весь набір.

    Завантаження аватара в `e2e-live` немає: upload покривають `upload-limits.transport.spec.ts`
    і ручний golden path нижче. Mock-набір `test:e2e` (проти `vite preview`) uWS не торкається.

- [ ] Обидва рантайми ESM-входу (`import * as uWS` у `server.ts:2` і `import { getParts }` у
      `http-request-handlers.ts:8`): `pnpm dev:backend` (tsx) і `pnpm build && pnpm start`
      (`node dist/index.js`) стартують і відповідають на `/api/ping`.
- [ ] Linux-бінарник, явно по архітектурах. Ні `make app-build`, ні `make prod-smoke` платформу
      не фіксують: на Apple Silicon вони перевіряють **linux/arm64**. Цільова архітектура
      розгортання (Hetzner + Dokploy) ще не зафіксована — CX/CPX це amd64, CAX — arm64, тому
      перевіряємо обидві:
    - **linux/x64** — CI на `ubuntu-24.04`/`ubuntu-latest` (x64): `quality` (усі
      `*.transport.spec.ts`, зокрема `uws-parser`), `test-pg`, `test-redis`, `e2e-live` —
      посилання на зелені джоби. Образ — `DOCKER_DEFAULT_PLATFORM=linux/amd64 make app-build &&
make prod-smoke` (під емуляцією повільно, але це той самий образ, що піде на CX).
    - **linux/arm64** — `make app-build && make prod-smoke` на Apple Silicon.
    - У кожному контейнері записати в `progress.md` вивід
      `docker exec <app> node -p "process.platform+' '+process.arch+' abi '+process.versions.modules"`
      (очікувано `linux x64 abi 137` / `linux arm64 abi 137`) і `/api/ready` з `"status":"ok"`.
      Не `/health`: такого маршруту немає, а при `SERVE_STATIC=true` він віддасть 200 з
      `index.html`. `make app-build` збирає обидва образи (app і landing), `docker build .` —
      лише app.
- [ ] Вручну golden path: логін → WS-підключення і повідомлення → upload аватара → `SIGTERM`
      (graceful shutdown: `us_listen_socket_close`, закриття WS, без падіння).
- [ ] `pnpm audit --prod --audit-level=high` (як у `audit.yml`) без нових записів.

## Ризики і відкат

| Ризик                                                                 | Що робимо                                                                                                      |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Новий запис UTF-8 (`NativeString`) змінив значення заголовків або тіл | Ловлять `header-values.live.spec.ts`, `multipart-parse.spec.ts`, transport-тести. Розбір причини перед мерджем |
| Linux-бінарник поводиться інакше, ніж macOS                           | x64 — CI + образ `linux/amd64`; arm64 — образ на Apple Silicon; platform/arch/ABI у `progress.md`              |
| Трейлер з помилкою після відпрацювання контролера                     | Тест класу 2 фіксує поведінку; рішення (якщо треба) — окрема фіча                                              |
| Інтеграція, що шле сирий UTF-8 у шляху, отримає 400                   | Задокументовано; це відповідає RFC 9112 і поведінці Node.js                                                    |
| Між 20.71 і 20.72 два місяці змін у JS-обгортці                       | Реліз свіжий (2026-11-24). Якщо знайдеться регресія — `git revert` фічі повертає `v20.71.0` разом з патчем     |

**Відкат образу.** Production і registry зараз немає (шаблон), тож «попереднього робочого
образу» на сервері теж немає. Перед першим `make app-build` на гілці зберегти образи з `main`:
`docker tag vibe-template:local vibe-template:uws-20.71` (і так само landing), а їхні digest
(`docker image inspect --format '{{.Id}}'`) записати в `progress.md`. Поки готується
`git revert`, `APP_IMAGE=vibe-template:uws-20.71 LANDING_IMAGE=vibe-template-landing:uws-20.71`
(обидві змінні читає `docker-compose.yml`) піднімає попередню версію одразу. Коли з'явиться
деплой через Dokploy, правило стає таким: тег або digest попереднього релізу записується в PR
оновлення.

Supply-chain без змін: пакет, як і раніше, ставиться з `codeload.github.com` за SHA коміту без
integrity-хеша (I-4, feat-207, прийнято в `dependency-upgrade-plan.md`).

## Поза обсягом

- Microcaching (`HttpCache`) — окремий план у `future/`.
- Перехід на HTTP/3 (`H3App`), компресія WS.
- Оновлення Node / ABI.
