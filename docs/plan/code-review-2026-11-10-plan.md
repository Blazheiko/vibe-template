# План виправлень за code review шаблону (2026-11-10)

**Статус: виконано, крім C6, редакція 2 (2026-11-11: V01–V20, C0, C1, C7, C4.1–C4.5, C8, C5b; додатково feat-178, feat-179; C6 чекає рішення власника)** (узгоджено з task list редакції 2: позначки suites для V09 і C1,
перевірка графа модулів у C0/C1, правило «не відтворено» на окрему знахідку). Джерело: `docs/plan/code-review-2026-11-10-report.md` (редакція 2),
рев'ю всього репозиторію на `main` @ `cbcc6a1`. Номери знахідок (`M1…M11`) і назви дрібних — зі звіту.

Знахідки знайдено читанням коду; тести, Docker і браузер під час рев'ю не запускалися. Тому перед
початком кожної фічі знахідку відтворюємо тестом (RED), і лише тоді виправляємо. Якщо знахідка не
відтворюється, позначку «не відтворено» отримує саме вона; решта знахідок фічі виконується. Фіча
закривається без змін у коді лише коли не відтворилася жодна її знахідка.

## Правила

- Кожна фіча — окремий запис у `feature_list.json` через PR у `main`. Id нижче (`V01…`, `C0…`) —
  робочі; реальний id (`feat-147`, …) присвоюється при створенні запису.
- Одна фіча в роботі на власника; `progress.md` і `session-handoff.md` — на гілці фічі.
- Шаблон без продакшену: без зворотної сумісності, міграції даних не потрібні.
- Зміна публічної поведінки бекенду (env, маршрут, middleware, схема) оновлює сторінку в
  `documentation/backend/` в обох мовах у тому ж PR; `pnpm docs:build && pnpm docs:verify`.
- `session_web` / `csrf_guard` лишаються явними на групі маршрутів; глобальне підключення не
  пропонується.

### Definition of Done (доповнення до `AGENTS.md`)

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, ручна перевірка, evidence у `progress.md`.
- `pnpm test` не запускає `*.pg.test.ts` і `*.redis.test.ts`. Фіча з позначкою **PG** або **Redis**
  також вимагає `pnpm --filter backend test:pg` / `test:redis` на піднятих тестових сервісах; у
  evidence — вивід, де цільові тести виконані, а не пропущені.
- Фіча з позначкою **e2e** вимагає `pnpm --filter frontend test:e2e`.
- Кожне виправлення має тест, що падає до зміни.
- Тести гонок і порядку подій використовують керовані бар'єри (deferred-проміс), а не `setTimeout`.

## Рішення, потрібні від власника

**Прийнято 2026-11-10:** Д1–Д6 — рекомендовані варіанти (Д2: 120 повідомлень/хв на з'єднання і 8
одночасних обробників на сокет).

**Уточнення 2026-11-11 (feat-160), підтверджено власником того ж дня («на твій розсуд»):** Д5 виконано у вужчому вигляді — новий код після cooldown
отримує лише сесія, що почала скидання. Видавати його будь-якій сесії означало б, що той, хто знає
номер, може раз на хвилину скасовувати чуже скидання; старий код захищав від цього окремим тестом.

**Рішення C1.R, 2026-11-11 (власник): варіант А — переносити решту маршрутів на контракти за
поточним дизайном (ADR 0005).** Пілот перевірив дизайн на трьох видах маршрутів і знайшов
справжню розбіжність типів; компроміси пілота не заважають міграції. **Цільовий стан**, до якого
приходимо в межах хвилі 7: (1) контракт — єдиний спосіб оголосити маршрут, `defineRoute` без
контракту зникає; (2) схеми маршруту беруться з одного реєстру за контрактом і не вказуються
вдруге в таблиці маршрутів; (3) контракт описує й multipart, а також відповіді, що не є JSON
(редірект, файл). Порядок: спершу реєстр схем (C7), бо від нього залежить форма кожного
перенесеного маршруту, — інакше ~50 маршрутів довелося б переписати двічі; потім групи C4.1–C4.5;
потім не-JSON (C8); єдиний `defineRoute` і заборона обходів — у C5b, коли старих маршрутів не
лишиться.

Критерії приймання нижче написані під рекомендований варіант. Якщо рішення інше, відповідна фіча
переписується до старту.

| #   | Питання                                              | Рекомендація                                                                                                                                                                        | Альтернатива                                                                   |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Д1  | Що робити з push-підпискою браузера при виході (V02) | При виході клієнт знімає підписку в браузері й видаляє її на сервері (best-effort); при вході підписка, що лишилася від іншого акаунта, знімається                                  | Мовчки переносити підписку на акаунт, що увійшов                               |
| Д2  | Ліміт WS-повідомлень до перевірки сесії (V03)        | Бюджет на з'єднання в пам'яті процесу (env, типово 120 повідомлень/хв) і не більше 8 одночасних обробників на сокет; перевищення → відповідь `rate_limit`, при тривалому — закриття | Лише бюджет на з'єднання, без обмеження одночасних обробників                  |
| Д3  | Скріншоти вимкнених статей бази знань (V14)          | Вимкнення означає заборону доступу: `GET /support/screenshot/:articleId` → 404                                                                                                      | Вимкнення означає лише приховування з пошуку; задокументувати                  |
| Д4  | Сесія викликача в строгій реєстрації (V11)           | Знищувати сесію в обох гілках (адреса зайнята / вільна)                                                                                                                             | Не знищувати в жодній                                                          |
| Д5  | Повторний старт скидання пароля за телефоном (V14)   | Після cooldown видавати новий код, як у реєстрації та link-флоу                                                                                                                     | Лишити повернення старого challenge, але не списувати ліміт за ненадіслане SMS |
| Д6  | Формат фіксації дизайну API-контрактів (C0)          | ADR `docs/adr/0005-route-contracts.md`                                                                                                                                              | Розділ у цьому плані                                                           |

## Фічі і залежності

| Фіча | Назва                              | Знахідки                                                               | Пріоритет | Залежності   | Розмір        | Suites  |
| ---- | ---------------------------------- | ---------------------------------------------------------------------- | --------- | ------------ | ------------- | ------- |
| V01  | Push Log Isolation                 | M2                                                                     | high      | —            | S             | PG      |
| V02  | Push Subscription Account Sync     | M9                                                                     | high      | V01, Д1      | M             | e2e     |
| V03  | WS Message Budget                  | M1; дрібна: маршрут `constructor`                                      | medium    | Д2           | M             | Redis   |
| V04  | Log Privacy: Support, Push, Mail   | M3; дрібні: `WebPushError`, адреси отримувачів, OAuth `state`          | medium    | —            | S             | —       |
| V05  | WS Client Close Handling           | M8                                                                     | medium    | —            | M             | e2e     |
| V06  | Support Chat Stream Recovery       | M11                                                                    | medium    | V05          | S             | e2e     |
| V07  | Docker API Prefix Build Arg        | M6                                                                     | medium    | —            | S             | —       |
| V08  | Sign-in Redirect                   | M10                                                                    | medium    | —            | S             | e2e     |
| V09  | Online History Pagination          | M4; дрібна: `/admin/users` без курсора                                 | medium    | —            | S             | PG, e2e |
| V10  | Push Subscription Input Bounds     | M5                                                                     | medium    | V01          | S             | PG      |
| V11  | Strict Registration Session Oracle | дрібна: `auth-service.ts:414`                                          | medium    | Д4           | S             | Redis   |
| V12  | Playground Error Reporting         | M7; дрібна: WS-помилки як успіх                                        | low       | —            | S             | —       |
| V13  | Backend Core Lows                  | IPv6 у `TRUSTED_PROXY_CIDRS`, 404 без CORS, `Expose-Headers`, `/ready` | low       | —            | S             | PG      |
| V14  | Support and Auth Lows              | KB і підтримка (6 пунктів), скидання за телефоном                      | low       | Д3, Д5       | M             | PG      |
| V15  | Schema Bounds Lows                 | межі промптів і KB, ім'я з OAuth, необмежені `BigInt` id               | low       | V10          | S             | PG      |
| V16  | Frontend Lows                      | 401 → `/login`, ключі кешу SW, precache, список KB, breadcrumb         | low       | V05          | M             | e2e     |
| V17  | Dead Code Cleanup                  | мертвий код бекенду й фронтенду                                        | low       | V02, V16     | S             | —       |
| V18  | Modal Accessibility                | модальні вікна, кнопки-іконки                                          | low       | —            | S             | e2e     |
| V19  | Playground Lows                    | навантажувальний тест, порожній токен, налаштування, консоль           | low       | V12          | S             | —       |
| V20  | Docs Home Page Accuracy            | зауваження до PR #473                                                  | low       | —            | XS            | —       |
| C0   | Route Contracts Design             | рішення дизайну 1–5 зі звіту                                           | medium    | Д6           | S             | —       |
| C1   | Route Contracts Pilot              | кроки C1–C3 + C5a                                                      | medium    | C0, V02, V10 | M             | PG, e2e |
| C4   | Route Contracts Migration          | решта груп маршрутів                                                   | low       | C1           | S × N         | —       |
| C5b  | Route Contracts Lock               | зняття винятків, тест покриття                                         | low       | C4           | S             | —       |
| C6   | WebSocket Contracts                | окремий дизайн                                                         | low       | C5b          | окрема оцінка | —       |

### Відповідність робочих id і записів `feature_list.json`

| Робочий id | Фіча       | Назва                              |
| ---------- | ---------- | ---------------------------------- |
| V01        | `feat-147` | Push Log Isolation                 |
| V02        | `feat-148` | Push Subscription Account Sync     |
| V03        | `feat-149` | WS Message Budget                  |
| V04        | `feat-150` | Log Privacy: Support, Push, Mail   |
| V05        | `feat-151` | WS Client Close Handling           |
| V06        | `feat-152` | Support Chat Stream Recovery       |
| V07        | `feat-153` | Docker API Prefix Build Arg        |
| V08        | `feat-154` | Sign-in Redirect                   |
| V09        | `feat-155` | Online History Pagination          |
| V10        | `feat-156` | Push Subscription Input Bounds     |
| V11        | `feat-157` | Strict Registration Session Oracle |
| V12        | `feat-158` | Playground Error Reporting         |
| V13        | `feat-159` | Backend Core Lows                  |
| V14        | `feat-160` | Support and Auth Lows              |
| V15        | `feat-161` | Schema Bounds Lows                 |
| V16        | `feat-162` | Frontend Lows                      |
| V17        | `feat-163` | Dead Code Cleanup                  |
| V18        | `feat-164` | Modal Accessibility                |
| V19        | `feat-165` | Playground Lows                    |
| V20        | `feat-166` | Docs Home Page Accuracy            |
| C0         | `feat-167` | Route Contracts Design             |
| C1         | `feat-168` | Route Contracts Pilot              |
| C7         | `feat-172` | Route Contract Schema Registry     |
| C4.1       | `feat-169` | Admin Monitoring Routes Contracts  |
| C4.2       | `feat-173` | Knowledge Base Routes Contracts    |
| C4.3       | `feat-174` | Core, Prompts, Support Contracts   |
| C4.4       | `feat-175` | Auth Session Routes Contracts      |
| C4.5       | `feat-176` | Auth Recovery and OAuth Contracts  |
| C8         | `feat-177` | Non-JSON Route Contracts           |
| C5b        | `feat-170` | Route Contracts Lock               |
| C6         | `feat-171` | WebSocket Contracts                |

Жорсткі залежності:

- **V01 → V02.** Сценарій «A → вихід → B» перевіряється наскрізно лише коли обидва боки виправлені.
- **V01 → V10 → V15.** Усі три змінюють схеми й репозиторій push-підписок або спільне відображення
  помилок PostgreSQL.
- **V05 → V06, V16.** Усі змінюють `useWebSocketConnection.ts` і обробку закриття сокета.
- **V02, V10 → C1.** Пілот контрактів переписує виклики групи `push-subscriptions`; спершу мають
  стабілізуватися її поведінка і схеми.
- **V02, V16 → V17.** Чистка мертвого коду після того, як фічі визначать, що справді не потрібне
  (обгортки push API, `useToast`).

Зв'язок із наявною фічею: **feat-061 Session Token Cache** зменшила б ціну перевірки сесії на кожне
WS-повідомлення, але вона не планується (ADR 0002: кеш не виправдовує ризик пропустити відкликану
сесію). V03 від неї не залежить.

### Порядок (хвилі)

1. **Хвиля 1 — приватність:** V01, V02 (після Д1).
2. **Хвиля 2 — доступність і логи:** V03 (після Д2), V04.
3. **Хвиля 3 — підтверджені функціональні дефекти:** V05, V06, V07, V08.
4. **Хвиля 4 — невеликі задачі:** V09, V10, V11 (після Д4), V12.
5. **Хвиля 5 — пілот контрактів:** C0 (після Д6), C1.
6. **Хвиля 6 — дрібні:** V13, V14 (після Д3, Д5), V15, V16, V18, V19, V20, потім V17.
7. **Хвиля 7 — контракти далі:** C7, C4.1–C4.5, C8, C5b, C6 (послідовно).

## Фічі

Шляхи бекенду відносно `packages/backend/src/`, фронтенду — `packages/frontend/src/`, якщо не
вказано інше.

### V01 — Push Log Isolation (M2) · PG · high

**Зміни**

- `repositories/notifications/push-notification-log-repository.ts`: `latestBySubscriptionIds` і
  `countsBySubscription` приймають `userId` і фільтрують також за `push_notification_logs.user_id`
  (колонка вже є). Сусідній `getLogsBySubscriptionId` уже фільтрує так.
- Викликачі: `findByUserIdWithLogs` (список підписок із журналами) і
  `getPushSubscriptionStatistics` передають власника.
- Перевірити третій канал читання — `GET /push-subscriptions/:id/logs`.

**Критерії приймання**

- A має підписку з рядками журналу; підписка переходить до B (той самий endpoint і ключі).
  `GET /push-subscriptions/` для B не містить заголовків A в `notificationLogs`.
- `GET /push-subscriptions/:id/statistics` для B рахує лише надсилання B.
- `GET /push-subscriptions/:id/logs` для B не повертає рядків A.
- Журнали A не видаляються: після зворотного переходу підписки A знову бачить свої.
- Тести в `push-subscription-ownership.pg.test.ts` або поруч, на одному fixture для всіх трьох
  каналів.

### V02 — Push Subscription Account Sync (M9; після V01; рішення Д1) · e2e · high

**Зміни**

- `stores/push.ts`: `subscribeToPush` при наявній підписці браузера не повертає успіх одразу, а
  надсилає її на сервер (`POST push-subscriptions` — це upsert, бекенд уже вміє перенести endpoint
  при збігу ключів). Стан «увімкнено» виставляється лише після відповіді сервера.
- Вихід (`composables/useSessionLifecycle.ts`): до запиту виходу — видалити підписку на сервері й
  викликати `unsubscribe()` у браузері. Обидві дії best-effort: помилка не блокує вихід.
- Вхід / `init_app`: якщо в браузері є підписка, якої немає серед підписок поточного користувача,
  вона знімається (Д1). Користувач вмикає push заново явно.
- `stores/__tests__/push.spec.ts:83` зараз закріплює ранній вихід — переписати.

**Критерії приймання**

- A вмикає push, виходить; B входить у тому самому браузері: B не отримує push користувача A, а в
  налаштуваннях B push показано вимкненим.
- B вмикає push: на сервері підписка належить B, тестовий push доходить.
- `pushManager.subscribe` вдався, `POST push-subscriptions` повернув помилку (429, мережа): UI
  показує помилку; повторна спроба надсилає `POST` і після успіху показує «увімкнено».
- Вихід без мережі до push-сервісу завершується; підписка, що лишилася, знімається при наступному
  вході іншого користувача.
- `documentation/backend/web-push-notification.md` (обидві мови): поведінка при зміні акаунта.

### V03 — WS Message Budget (M1; рішення Д2) · Redis · medium

**Зміни**

- `vendor/utils/network/ws-handlers.ts`, `onMessage`: лічильник повідомлень на з'єднання в
  `userData` (ковзне вікно в пам'яті процесу, без Redis) перевіряється першим кроком, до
  `refreshToken` і `wsSessionHandler`. Під бюджет потрапляють усі текстові повідомлення, крім
  `ping`; для `ping` — окремий, більший бюджет.
- Обмеження одночасних обробників на сокет: понад ліміт повідомлення відхиляється одразу.
- Перевищення → відповідь з кодом `rate_limit` і подією запиту, якщо її вдалося прочитати; при
  перевищенні кілька вікон поспіль — закриття сокета кодом із діапазону 4000–4099 (клієнт не
  перепідключається).
- `config/websocket.ts`, `.env.example`: `WS_MESSAGES_PER_MINUTE`, `WS_MAX_CONCURRENT_HANDLERS`.
- `vendor/start/router.ts:132`: мапа WS-маршрутів без прототипу (`Object.create(null)` або `Map`),
  щоб `constructor`, `__proto__`, `toString` не вважалися маршрутами.

**Критерії приймання**

- Понад бюджет валідних повідомлень з невідомою подією: після порогу `wsSessionHandler` не
  викликається (лічильник викликів `findSessionToken` не росте), клієнт отримує `rate_limit`.
- Повідомлення з невалідним JSON понад бюджет не викликають `refreshToken`.
- Тривале перевищення закриває сокет; клієнтська `resolveWebSocketCloseAction` для цього коду
  повертає `stop`.
- Звичайний сценарій (чат підтримки, heartbeat) у бюджет вкладається — наявні WS-тести зелені.
- `{"event":"constructor",…}` → `not_found`, без error-логу.
- `documentation/backend/` (WebSocket, конфігурація), обидві мови.

Вплив флуду на пул перевірки сесій (503 для інших) у звіті лишається гіпотезою. Якщо є бажання її
підтвердити — окремий навантажувальний прогін до виправлення, результат у `progress.md`.

### V04 — Log Privacy: Support, Push, Mail (M3 і три дрібні) · medium

**Зміни**

- `services/support/support-query-translation-service.ts:63`: прибрати `originalQuery` з логу,
  лишити `originalLength`. Обрив клієнтом (abort) логувати не як error.
- `services/notifications/push-notification-sender-service.ts:194`: логувати `statusCode` і
  нормалізовану причину, без `endpoint`, `headers`, `body` з `WebPushError`.
- `services/notifications/email-service.ts:214-222`: `accepted` / `rejected` через
  `maskEmailForLogs` або лише кількість.
- `controllers/http/auth/oauth-controller.ts:93`: логувати провайдера, без URL зі `state`.

**Критерії приймання**

- Тест на кожне місце: запис логу не містить тексту звернення / endpoint / повної адреси / `state`.
- Закриття вкладки під час перекладу не створює error-запису й події Sentry.
- `documentation/backend/oauth.md:66` і сторінка логування відповідають коду.

### V05 — WS Client Close Handling (M8) · e2e · medium

**Зміни**

- `composables/useWebSocketConnection.ts`: розрізняти закриття, яке ініціював клієнт
  (`websocketClose`, заміна сокета у `websocketOpen`), і втрату зв'язку. Подія `close` сокета, що
  вже не є поточним, або закритого навмисно, не викликає `resetApiResolve` для нового сокета і не
  планує перепідключення.
- `utils/websocket-close.ts`: навмисне закриття → `stop`.

**Критерії приймання**

- Вихід: через 5 с немає спроби перепідключення і немає запиту `main/update-ws-token`; користувач,
  що перейшов на `/register`, лишається там.
- Старий сокет закривається після відкриття нового (зміна пароля в `UserAccount.vue`): запит, що
  очікує на новому сокеті, завершується відповіддю, а не `WsDeliveryUnknownError`; новий сокет не
  закривається.
- Справжня втрата зв'язку (код 1006 після відкриття) як і раніше веде до перепідключення.
- Тест композабла з керованим порядком подій `close` / `open`, а не лише тест чистої функції.

### V06 — Support Chat Stream Recovery (M11; після V05) · e2e · medium

**Зміни**

- `views/SupportView.vue`, `stores/support.ts`: стан «відповідь триває» скидається також при
  закритті сокета і при відході зі сторінки; частковий текст відкидається або завершується
  позначкою помилки.
- Після відновлення з'єднання історія перечитується, щоб показати відповідь, якщо сервер устиг її
  зберегти.

**Критерії приймання**

- Повідомлення прийняте, сокет рветься: поле вводу й кнопка знову активні; повідомлення користувача
  в історії одне, без дубля.
- Відхід зі сторінки посеред відповіді й повернення: немає завислого часткового тексту; наступна
  відповідь не дописується до старого.
- Звичайне завершення потоку працює як раніше.

### V07 — Docker API Prefix Build Arg (M6) · medium

**Зміни**

- `Dockerfile`: `ARG VITE_API_PATH_PREFIX` (і `VITE_API_BASE_URL`, якщо фронтенд його читає) поруч
  із `VITE_SENTRY_*`.
- `docker-compose.yml` / `pnpm app:up`: передавати build-arg із того самого значення, що й
  `API_PATH_PREFIX` бекенду.
- Запобіжник на старті: якщо бекенд роздає статику й `API_PATH_PREFIX` не збігається з префіксом
  зібраної SPA — помилка або попередження в лозі (спосіб звірки визначити в фічі; наприклад, файл
  із префіксом у `dist`).
- `documentation/backend/deployment.md` (обидві мови): сценарій з нетиповим префіксом вимагає
  build-arg.

**Критерії приймання**

- Образ, зібраний з `--build-arg VITE_API_PATH_PREFIX=v1` і запущений з `API_PATH_PREFIX=v1`:
  `GET /v1/…` з SPA працює (ручна перевірка, evidence).
- Образ із типовим префіксом, запущений з `API_PATH_PREFIX=v1`: розбіжність видно в лозі старту.

### V08 — Sign-in Redirect (M10) · e2e · medium

**Зміни**

- `composables/useCompleteSignIn.ts`: ціль після входу — `safeRedirectTarget(route.query.redirect)`,
  інакше `UserAccount`. Значення читається до закриття модального вікна.
- Той самий шлях для входу через OAuth (параметр зберігається на час переходу до провайдера).

**Критерії приймання**

- Анонім відкриває `/support` → `/login?redirect=%2Fsupport` → вхід через форму → `/support`
  (AC-AUTH-001).
- `redirect=https://evil.example` і `redirect=//evil.example` → `/account`.
- Вхід без `redirect` → `/account`, як раніше.
- OAuth-вхід із `redirect` → цільова сторінка.

### V09 — Online History Pagination (M4) · PG · e2e · medium

**Зміни**

- `repositories/communication/user-online-repository.ts:94`: репозиторій не обрізає `limit`
  самостійно нижче за запитане сервісом `limit + 1` (межу тримає сервіс).
- `/admin/users`: курсор або зсув, щоб записи поза першою сотнею були досяжні.

**Критерії приймання**

- 99, 100 і 101 запис при `limit=100`: `hasMore` відповідно `false`, `false`, `true`; друга
  сторінка для 101 містить один запис.
- `limit=200` (дозволений схемою) поводиться послідовно зі схемою: або працює, або схема
  обмежена 100.
- `/admin/users` із 101 користувачем: 101-й досяжний.

### V10 — Push Subscription Input Bounds (M5; після V01) · PG · medium

**Зміни**

- `packages/shared/src/schemas/push-subscription/create-subscription.ts`, `update-subscription.ts`:
  межі довжини за колонками (`schema.ts:128-147`) і розумні межі для полів `text` (`p256dhKey`,
  `authKey`, `userAgent`).
- `ipAddress` прибрати зі схеми запиту; сервер записує `context.httpData.ip`.
- Фронтенд (`stores/push.ts`, `utils/push-device.ts`) не надсилає `ipAddress`.

**Критерії приймання**

- `deviceType` із 51 символу, `endpoint` понад 500, ключ понад межу → 422, не 500.
- Запит із `ipAddress` → 422 (`'+': 'reject'`); у рядку БД — адреса клієнта з боку сервера.
- Наявний сценарій підписки з реального браузера проходить.

### V11 — Strict Registration Session Oracle (рішення Д4) · Redis · medium

**Зміни**

- `services/auth/auth-service.ts`, `registerEmailFlow`: однакова дія із сесією викликача в усіх
  гілках, що повертають `genericEmailRegistrationAnswer()` (рядки 371-373, 408-410, 414).

**Критерії приймання**

- Викликач зі збереженою сесією надсилає `POST /auth/register/email` на зайняту й на вільну адресу:
  стан сесії після відповіді однаковий в обох випадках.
- Гонка реєстрації (feat-100) поводиться так само, як гілка «зайнято».
- Тести вирівнювання часу (feat-099) зелені.

### V12 — Playground Error Reporting (M7 і дрібна) · low

**Зміни**

- `packages/api-playground/src/utils/base-api.ts`: тіло читається для будь-якої відповіді з JSON
  (`content-type`), не лише 422; відповідь без тіла (204, редирект) не вважається мережевою
  помилкою.
- `baseApi.ws` і `TestFormWs.vue`: помилка й таймаут WS показуються як помилка зі статусом і
  повідомленням сервера.

**Критерії приймання**

- 403 від CSRF: у панелі видно `code` і `reason`.
- 204 показується як успіх зі статусом 204.
- WS-маршрут відповідає 422 або не відповідає: панель показує помилку, а не зелений 200.

### V13 — Backend Core Lows · PG · low

- `vendor/utils/network/ip-address.ts:154-157`: адреса без префікса в `TRUSTED_PROXY_CIDRS`
  порівнюється в числовій формі; тест `::1` проти розгорнутого запису.
- `vendor/start/server.ts:672,683`: 404 з `{ origin }`; тест з увімкненим CORS.
- `config/cors.ts:61`: `Access-Control-Expose-Headers` через кому.
- `database/readiness-probe.ts:77`: паралельні запити `/ready` ділять один проміс перевірки
  замість відмови; гарантія «одне з'єднання» (feat-113) зберігається.

### V14 — Support and Auth Lows (рішення Д3, Д5) · PG · low

- `support-embedding-service.ts:78-90`: `reindexAll` продовжує після збою пакета й повертає
  перелік статей, що не проіндексовані.
- `support-service.ts:443`: з контексту виключається поточне повідомлення за id, а не за текстом.
- `support-knowledge-repository.ts:50-54`: `ORDER BY` у `findAll`.
- `support-service.ts:417,428`: бюджет не списується за переклад чи embedding, якщо виклику
  провайдера не було (ADR 0003, п. 5).
- `knowledge-base-service.ts:290-293`: скріншот вимкненої статті → 404 (Д3).
- `password-reset-service.ts:246-275`: повторний старт після cooldown видає новий код (Д5);
  оновити `password-reset-service.contract.spec.ts:734-763`.

### V15 — Schema Bounds Lows (після V10) · PG · low

- `packages/shared/src/schemas/main/prompt-update.ts`, `prompt-test.ts`: `maxTokens` — додатне ціле
  з верхньою межею, `temperature` у межах провайдера, `model` до 100 символів.
- `packages/shared/src/schemas/support/support-knowledge-base.ts`: `title` ≤ 255, `category` ≤ 100,
  межа для `content`.
- `services/auth/oauth-service.ts:782-790`: ім'я з провайдера обрізається до 100 символів; URL
  аватара провайдера не потрапляє в поле, яке `avatar-service.ts` трактує як ключ S3.
- Числові id із шляху та query (`support-controller.ts:54`, `parseId` KB, `cursor` / `userId`
  історії) перевіряються на діапазон `bigint` → 422 / 404 замість 500.

### V16 — Frontend Lows (після V05) · e2e · low

- `utils/base-api.ts:330-332`: глобальна подія `unauthorized` лише для 401, що означають втрату
  сесії; `/verify-email` встигає показати своє пояснення.
- `service-worker.ts:322-327`: HTML-оболонка кешується під ключем без query.
- `service-worker.ts:34-39`: список precache відповідає `public/`; mp3 прибрати разом із файлами,
  якщо звук не використовується (узгодити з V17).
- `utils/api.ts:444`: `adminKnowledgeBaseApi.getAll` повертає помилку; `AdminKnowledgeBaseView.vue`
  показує її й перевіряє результати завантаження скріншота, видалення, переіндексації.
- `utils/sentry-service.ts:233-235`: `maskUrl` застосовується лише до значень, що є URL.

### V17 — Dead Code Cleanup (після V02, V16) · low

- Бекенд: `scripts/copy-static.js`; `MainController.testHeaders` / `getSetCookies` / `testSession`;
  поле `token` у схемах реєстрації та входу; `sms_auth_challenges.send_count` (прибрати або почати
  вести).
- Фронтенд: `stores/counter.ts`, `utils/isToday.ts`, `ConnectionStatus.vue`, `LoaderOverlay.vue`,
  `components/icons/*`, `useLocale()`, невикористані обгортки API, подія `destroy_websocket_base`,
  кнопка звуку сповіщень без обробника.
- `useToast` / `ToastContainer`: або прибрати, або почати використовувати (рішення в фічі).
- Локальні типи `PushSubscriptionResponse` в `utils/api.ts:265-349` — якщо їх не прибрав пілот C1.

### V18 — Modal Accessibility · e2e · low

- `AuthModalShell.vue`, `AdminUserDetailModal.vue`, `AvatarEditorModal.vue`: `role="dialog"`,
  `aria-modal`, початковий фокус, утримання фокуса, закриття на Escape, повернення фокуса.
- Назви для кнопок-іконок (закриття редактора аватара, надсилання в чаті підтримки).

### V19 — Playground Lows (після V12) · low

- `utils/load-test.ts:204`: середній час — середнє тривалостей запитів.
- `TestForm.vue`, `useLoadTest.ts`: межі потоків і запитів перевіряються в коді; кнопка зупинки.
- `useWebSocketConnection.ts:49,335`: порожній токен не передається як subprotocol.
- `ApiSettingsModal.vue:131`, `stores/api-settings.ts:117`: перевірка з'єднання працює через
  проксі; значення env має перевагу над застарілим збереженим `baseUrl`.
- `utils/base-api.ts`, `stores/api-doc.ts:288`: тіло запиту й відповіді не пишуться в консоль або
  проходять те саме маскування, що й заголовки.

### V20 — Docs Home Page Accuracy · low

- `documentation/index.md`, `documentation/en/index.md`: формулювання про `ResponseSchema`
  відповідає режимам `strict` / `log`; обидві мови однакові за змістом.
- `documentation/guide/how-backend-works.md:170` і `documentation/backend/adding-a-feature.md:59`
  (та англійські близнюки) узгоджені з `config/response-validation.ts`.
- Розділ про три контракти згадує контроль доступу до маршрутів і рев'ю змін у тестах.

### C0 — Route Contracts Design (рішення Д6) · medium

Зафіксувати п'ять рішень зі звіту:

1. Межа пакетів: браузеру — метод, шлях і типи; серверу — прив'язка схем. Схеми ArkType не
   потрапляють у бандл фронтенду.
2. Вхідний тип схеми для клієнта, вихідний — для обробника.
3. Повна форма виклику (`params`, `query`, `body`, `signal`, клієнтські опції) поверх поточного
   транспорту `utils/base-api.ts` з його CSRF і перевіркою зміни акаунта.
4. Middleware, guards, ліміти — конфігурація бекенду, поза контрактом.
5. Побудова URL: кодування параметрів шляху, серіалізація query.

**Критерій приймання:** документ містить приклад контракту, серверної прив'язки й клієнтського
виклику для трьох маршрутів пілота, і перевірку на графі модулів production-збірки, що браузерний контракт не створює
runtime-залежності від схем (команда й очікуваний результат названі). Документ також називає межу
підтримки multipart.

### C1 — Route Contracts Pilot (після C0, V02, V10) · PG · e2e · medium

**Зміни**

- Каркас контрактів у `packages/shared`, `defineRoute` з контрактом на бекенді, типізований клієнт
  на фронтенді.
- Три маршрути пілота: група `push-subscriptions`, один маршрут із query (наприклад, список
  користувачів адмінки), один маршрут автентифікації (`auth/login`).
- Правило ESLint забороняє нові прямі виклики `baseApi.http`; наявні — у явному списку винятків.
- `documentation/backend/` (маршрути, додавання фічі), обидві мови; навичка `backend-feature`, якщо
  вона описує `defineRoute`.

**Критерії приймання**

- Неправильний метод, body або params у виклику клієнта — помилка `pnpm typecheck` (тест типів).
- Обробник, що повертає не той тип відповіді, — помилка `pnpm typecheck`.
- Граф модулів production-збірки фронтенду не містить схем контракту (команда перевірки з C0);
  порівняння розміру доказом не вважається.
- Поведінка трьох маршрутів незмінна: наявні unit, PG і e2e тести зелені.
- Новий прямий виклик `baseApi.http` поза списком винятків — помилка `pnpm lint`.

### C7, C4, C8, C5b, C6 — Route Contracts далі (рішення C1.R: варіант А)

Стан на 2026-11-11: 12 маршрутів на контрактах, 50 — ні (`http-routes.ts`); на фронтенді 36
прямих викликів `baseApi.http` і 2 `baseApi.upload` в `utils/api.ts`.

- **C7 — реєстр схем (`feat-172`).** Серверний реєстр `контракт → { тіло, query, відповідь }`
  (схеми лишаються поза бандлом фронтенду). `defineContractRoute` бере схеми з реєстру; запис
  реєстру звіряється з типами контракту тими самими перевірками, що зараз у маршруті. 12 маршрутів
  пілота переходять на реєстр. Де живе реєстр (бекенд чи окремий серверний subpath `shared`) —
  перший пункт фічі, з урахуванням того, що playground серіалізує схеми маршрутів.
- **C4 — групи** (по одній фічі, у такому порядку; від простих до найчутливіших):

    | Фіча            | Маршрути                                                                                                                                                    | Бекенд | Прямі виклики фронтенду |
    | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------- |
    | C4.1 `feat-169` | `admin`: `users-online`, `users-online/:id`, `history-online`, `usage/text`, `usage/stats`                                                                  | 5      | 3                       |
    | C4.2 `feat-173` | `admin/knowledge-base/*` крім завантаження скриншота                                                                                                        | 10     | 9                       |
    | C4.3 `feat-174` | `/ping`, `/ready`, `main/*`, `prompts/*`, `support/chat/history` (GET, DELETE)                                                                              | 10     | 4                       |
    | C4.4 `feat-175` | `auth`: реєстрація (email, телефон ×3), `logout`, `logout-all`, `change-password`, `verify-email`, `resend-verification-email`                              | 9      | 9                       |
    | C4.5 `feat-176` | `auth`: `forgot-password`, `reset-password`, `reset-phone/*`, `link-phone/*`, `link-email/start`; `auth/oauth`: `providers`, `link/confirm`, `email/resend` | 10     | 10                      |

    `prompts/*` і `admin/usage/*` фронтенд не викликає; контракт потрібен для бекенду й C5b.

- **C8 — не-JSON (`feat-177`).** Контракт описує тіло multipart і відповіді-редірект та файл;
  `callApi` надсилає `FormData` через наявний транспорт. Переходять `avatar/upload`, `DELETE
avatar`, `knowledge-base/:id/screenshot` (POST), `support/screenshot/:articleId`,
  `auth/oauth/:provider/redirect` і `callback` — 6 маршрутів, 2 виклики `baseApi.upload`.
- **C5b — фіксація (`feat-170`).** Старий `defineRoute` видалено, `defineContractRoute` стає
  `defineRoute`; лічильник прямих викликів дорівнює нулю й видалений, прямий `baseApi.http` /
  `baseApi.upload` поза клієнтом — помилка `pnpm lint`; тест бекенду: кожен маршрут має контракт і
  запис реєстру, маршрути з тілом — схему тіла.
- **C6 — WebSocket (`feat-171`):** окремий дизайн після C5b, без змін.
