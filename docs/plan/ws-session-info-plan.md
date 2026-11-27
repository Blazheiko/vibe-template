# План: feat-274 — прибрати невикористану сесію з WS-контексту

Дата: 2026-11-27 (редакція 5, після третього рев'ю)

## Проблема

`ws-context.ts` приймає `_session: Session | null`, але ігнорує його і завжди повертає
`session: null, auth: null`. При цьому `ws-api-dispatcher.ts` передає туди сесію, завантажену
на це повідомлення. Поведінка правильна: тип `WsContext` і документація кажуть `session: null`.
Але сигнатура вводить в оману, сесію з методами зміни збирають на кожне повідомлення і викидають,
а документація в кількох місцях неточно описує, де і в якому порядку сесію перевіряють.

## Рішення

Прибрати невикористаний параметр і невикористані поля, а не додавати знімок сесії в контекст.
`wsSessionHandler` лишає три результати: `ok`, `missing`, `unavailable`.

Чому не знімок сесії (редакції 1–2 цього плану):

- `context.userData` — той самий об'єкт, що й `context.ws.getUserData()` (`ws-handlers.ts` бере
  його звідти). Дані з'єднання в контексті вже є.
- `UserConnection` уже містить усе, що потрібно обробникам: `userId`, `role` (синхронізує
  wsRoleSync), `auth` для MFA (feat-247), `ip`, `userAgent`, `appType`.
- Жоден WS-обробник не читає дані сесії. Знімок означав би нове публічне поле контракту без
  споживача і другий набір даних сесії поряд з `userData`.
- Дані сесії містять секрети серед прикладних ключів (OAuth PKCE verifier, TOTP enrollment
  `secret`, passkey challenge), тому будь-яка проєкція потребувала б окремого захисту.
- Фабрика контексту вже ігнорує передану сесію, а WS-перевірка MFA (`ws-permission-guard.ts`)
  читає `userData.auth`.

Якщо колись з'явиться WS-обробник, якому потрібні дані сесії, це окремий `feat-XXX` з явним
переліком полів і закритим типом.

**Що рефакторинг змінює і чого не змінює.** Зникає лише створення об'єкта `Session` з методами
зміни на кожне повідомлення. Читання JSON сесії лишається, і замінити його на `sessionExists`
не можна: `getSession` (`redis-session-storage.ts:167`) продовжує ковзний TTL активної сесії
(`getAndRenewTtlSeconds`), перевіряє `SESSION_MAX_AGE_DAYS` (`isPastMaxAge`) і дає
`data.userId` для перевірки автентифікації та `assertSessionTokenCurrent`. Перевірка
актуальності токена в PostgreSQL теж лишається частиною чинного контракту.

## Факти з коду

- `wsSessionHandler` (`session-handler.ts:82`) повертає `{ kind: 'ok'; session: Session }` і
  збирає `Session` з методами зміни на рядках 117–132. Єдиний, хто його використовує, — диспетчер,
  і той результат викидає.
- Поля `session: null` / `auth: null` у `WsContext` (`types.d.ts:109-110`) ніхто не читає і не
  використовує, щоб відрізнити HTTP-контекст від WS. `session: null` у `route-access.spec.ts:44` —
  фікстура `HttpContext`, а не `WsContext`.
- Сесію перевіряють на upgrade (`verifyUpgradeToken`, `ws-session-auth.ts`) і на повідомлення.
  Точний порядок в `onMessage` (`ws-handlers.ts`) і диспетчері:
    1. бінарне повідомлення → закриття з кодом 1003 (`closeBinaryConnection`, `ws-handlers.ts:314-317`);
    2. heartbeat (власний бюджет) і бюджет повідомлень;
    3. розбір і перевірка формату конверта повідомлення;
    4. пошук маршруту (`findWsRoute`, `ws-handlers.ts:398-401`, з feat-197): невідома подія
       отримує `not_found` без читання сесії;
    5. **перевірка сесії** (`wsSessionHandler`): `unavailable` → конверт `status: 'error'`,
       `error.code: 'service_unavailable'`, з'єднання лишається відкритим; `missing` → закриття з
       кодом 4001;
    6. у диспетчері: ліміт маршруту (`checkRateLimitWs`), валідація payload маршруту
       (`validateRoutePayload`), middleware, обробник.

    Отже, сесію перевіряють **до** ліміту маршруту і валідації payload.

- HTTP logout на тому самому інстансі сам закриває сокети цієї сесії з кодом 4001
  (`ws-session-revocation.ts:80`), не чекаючи наступної WS-події. Ще один механізм — періодична
  перевірка сесій (`ws-session-revocation.ts:184`, інтервал `sessionRecheckIntervalMs`).
- Upgrade-хук повертає `UpgradeTokenResult` (`ok` / `missing` / `unavailable`), а не «дані або
  `null`».

## 0. Підготовка (`AGENTS.md`)

1. PR у `main` з короткої гілки `chore/feat-274-start`: запис `feat-274` у `feature_list.json`
   (наступний вільний id після feat-273; `in_progress`, owner, branch
   `refactor/ws-context-session`, dependencies `[]`) і цей план. Merge commit після зелених
   перевірок.
2. Гілка `refactor/ws-context-session`, файл `feature-state/feat-274/progress.md`, `./init.sh`
   для перевірки, що база зелена.

## 1. Код

- `packages/backend/src/vendor/utils/context/ws-context.ts`: прибрати параметр `_session`, імпорт
  `Session` і поля `session: null`, `auth: null` з результату.
- `packages/backend/src/vendor/utils/routing/ws-api-dispatcher.ts`: прибрати параметр `session`,
  імпорт `Session` і закоментований рядок 81.
- `packages/backend/src/vendor/utils/session/session-handler.ts`:
    - звести `WsSessionResult` до `{ kind: 'ok' } | { kind: 'missing' } | { kind: 'unavailable' }`;
    - прибрати збирання `Session` (рядки 117–132);
    - прибрати імпорти, що стануть зайвими: функції з `redis-session-storage.js`, які
      використовувались лише там, і типи `Session`, `SessionData` у рядку 2 (лише якщо вони не
      потрібні решті файлу: `RequestSession` і HTTP-гілка мають свої імпорти);
    - перевірки (формат токена, наявність сесії, непорожній `userId`, актуальність
      `sessionToken`) не змінюються.
- `packages/backend/src/vendor/utils/network/ws-handlers.ts:417-423`: не передавати сесію в
  диспетчер.
- `packages/backend/src/vendor/types/types.d.ts`: прибрати `session: null` і `auth: null` з
  `WsContext`. Звернення до `context.session` / `context.auth` в обробнику для
  `HttpContext | WsContext` тепер потребує звуження типу, і це чесніше, ніж тип `null`.
  `pnpm typecheck` покаже всі місця, якщо вони є.

## 2. Тести

**Файли зі змінами (8):**

- `vendor/utils/session/ws-session-handler.spec.ts`:
    - успіх (рядок 47): замість `result.session.sessionInfo?.id` перевіряти **точний** результат
      `toEqual({ kind: 'ok' })`, аргументи `getSession` (`sessionId`, `userToken`) і що перевірку
      актуальності токена (checker з `registerSessionTokenChecker`) викликано;
    - нові кейси: невалідний формат `userToken` → `missing` без виклику `getSession`; сесія з
      порожнім `userId` → `missing` (`session-handler.ts:87-105`). Разом з наявними (ротація
      `sessionToken`, відсутня сесія, `unavailable`) це фіксує всі інваріанти, які план обіцяє
      зберегти;
    - **не** прибирати `updateSessionData` / `changeSessionData` / `destroySession` з
      `vi.mock('#vendor/utils/session/redis-session-storage.js')` (рядки 14–21): їх і далі
      імпортує `RequestSession` (`request-session.ts:25-40`), який підтягує `session-handler.ts`.
- `vendor/utils/network/ws-redis-unavailable.spec.ts:117-141`:
    - `session missing → closed as expired (4001)`: додати
      `expect(wsApiHandler).not.toHaveBeenCalled()` (у сусідньому тесті `unavailable` така
      перевірка вже є);
    - `session ok → dispatched`: мок `{ kind: 'ok' }` без `session`, очікування виклику
      `wsApiHandler` без аргументу сесії.
- `vendor/utils/network/ws-close-lifecycle.spec.ts` (рядки 86, 171): мок `{ kind: 'ok' }`. Тест на
  рядках 187–208 перевіряє гонку, коли сокет закрився під час `wsSessionHandler`; додати і туди
  `expect(wsApiHandler).not.toHaveBeenCalled()`.
- `vendor/utils/network/ws-message-budget.spec.ts:82`: мок `{ kind: 'ok' }`.
- `vendor/utils/network/ws-message-errors.spec.ts:61`: мок `{ kind: 'ok' }`.
- `vendor/utils/routing/ws-validation.spec.ts` (рядки 60, 103, 181): прибрати аргумент сесії з
  виклику диспетчера.
- `vendor/utils/routing/ws-error-envelope.spec.ts:36`: те саме.
- `vendor/utils/routing/ws-request-id.spec.ts:35`: те саме.

**Новий файл `vendor/utils/context/ws-context.spec.ts`** (зараз тесту для `ws-context.ts` немає):

- compile-time: `// @ts-expect-error` на `context.session` і на `context.auth`;
- runtime: `'session' in context === false`, `'auth' in context === false`,
  `context.userData === userData`.

**Без змін** (мають лишитися зеленими):

- `ws-upgrade-*.spec.ts` (4) і `vendor/start/*.transport.spec.ts` (6) мокають
  `wsSessionHandler: vi.fn()` без значення;
- heartbeat і невідомий маршрут не викликають `wsSessionHandler`: уже покрито в
  `ws-message-budget.spec.ts:110,130,139,155`;
- `app/services/auth/session-revocation.pg.test.ts` і
  `vendor/utils/session/session-store.redis.test.ts:310-322` перевіряють лише `.kind`.

`make test-pg` і `make test-redis` проганяються з реальними сервісами, у звіті кількість виконаних
і пропущених тестів.

## 3. Документація (обидві мови: `documentation/` і `documentation/en/`)

- **`backend/auth.md`:**
    - callout `::: warning WebSocket` (рядки 114–116): зараз там «`context.auth` і
      `context.session` дорівнюють `null`». Переписати: цих полів у `WsContext` немає, користувач
      визначається під час підключення, у обробнику — `context.userData`;
    - рядок 170 (стосується і підключення, і повідомлень): upgrade → HTTP `503` з
      `Retry-After: 1`; WS-повідомлення → конверт `status: 'error'`,
      `error.code: 'service_unavailable'`, з'єднання лишається відкритим;
    - рядок 344 (крок 4 про WebSocket): описати порядок перевірок з «Фактів з коду» і замінити
      «`503` message» на той самий конверт.
- **`backend/controllers.md`:**
    - блок `WsContext`: прибрати `session` і `auth`;
    - таблиця HTTP/WS, рядок «Session»: у WS сесії в контексті немає; дані користувача —
      `context.userData`, тобто той самий об'єкт, що й `context.ws.getUserData()`;
    - «WsContext in detail»: порядок перевірок (після формату конверта і пошуку маршруту, до ліміту
      маршруту і валідації payload; heartbeat і невідомі події раніше). Авторизація (роль,
      `auth`/MFA) читає `userData`;
    - `ws.getUserData()` явно назвати джерелом даних з'єднання (зараз лише в розділі
      `ws: MyWebSocket`, рядок 201), із застереженням: на закритому сокеті він кидає
      `Invalid access of closed uWS.WebSocket` (feat-107, `websocket.md:109`). Тому в обробнику,
      особливо після `await`, читати `context.userData`, отриманий до закриття; про закриття
      з'єднання сигналізує `context.signal`;
    - таблиця полів `userData` (рядки 236–250): додати рядок `auth` (`SessionAuthState` для MFA,
      feat-247; його читає `ws_can:`); у рядку `sessionId`, `userToken` додати «не логувати і не
      віддавати клієнту»;
    - рядки 242 і 261: `asUserId(userId)` → `parseUserId(userData?.userId)`, як у
      `support-controller.ts:21` після feat-272 (прикладний код у документації відповідає коду).
- **`backend/request-lifecycle.md`** (розділ «WebSocket: upgrade and messages», рядки 177–188):
    - діаграма: `Hooks-->>U: …or null` → `UpgradeTokenResult` (`ok` / `missing` / `unavailable`);
      `M->>M: validate envelope, wsSessionHandler` → порядок «envelope → route lookup →
      wsSessionHandler»; `M->>D: message, session` → без `session`;
    - пункт «Повідомлення» (рядок 187): «бінарні повідомлення ігноруються» → закриття з кодом 1003;
      додати пошук маршруту перед `wsSessionHandler`;
    - пункт «Диспетчер» (рядок 188): пошук маршруту і `not_found` перенести в `onMessage`
      (feat-197); у диспетчері лишаються ліміт маршруту, валідація payload, middleware, обробник.
- **`backend/websocket.md:222`:** «перевіряє сесію на **кожне** повідомлення, тож вихід із сесії по
  HTTP рве WS при наступному повідомленні» → на тому самому інстансі logout рве сокет одразу
  (`wsSessionRevocation`); перевірка на повідомленні — для відомих маршрутів після перевірки
  конверта, і вона ловить сесію, видалену деінде (інший інстанс, TTL).
- Нових сторінок немає. `pnpm docs:build && pnpm docs:verify`.
- **Уже перевірено, змін не потребує:** `backend/middlewares.md`, `backend/ai.md`,
  `en/backend/adding-a-feature.md`, `.claude/skills/backend-feature/SKILL.md:503` і
  `packages/backend/README.md:1391-1392` (там уже «no session or auth on WsContext»).

## 4. Перевірка і завершення

- `make check`, `make test-pg`, `make test-redis`, docs build/verify. Evidence фіксується в
  `feature-state/feat-274/progress.md`.
- Ручна перевірка основного сценарію в `make dev-playground`:
    1. вхід, WS-події `support` / `admin` відповідають як раніше;
    2. HTTP logout в іншій вкладці: сокет закривається з кодом 4001 одразу. Це робить
       `ws-session-revocation`, а не `wsSessionHandler`, тож гілку `missing` цей крок не перевіряє;
    3. (опційно) гілка `missing` наживо: при відкритому сокеті видалити ключ
       `session:<userToken>:<sessionId>` у Redis (`redis-cli DEL …`) і до наступної періодичної
       перевірки (`sessionRecheckIntervalMs`) надіслати WS-подію відомого маршруту: сокет має
       закритися з кодом 4001.

    Записати результат у `progress.md` без дампа даних сесії.

- Життєвий цикл:
    1. PR реалізації відкрито, evidence у `progress.md`;
    2. окремий PR у `main`: `feat-274` → `review` у `feature_list.json`;
    3. рев'ю → merge PR реалізації;
    4. окремий PR «Mark feat-274 done» (статус `done`, evidence, видалення
       `feature-state/feat-274/`).

## `pending` / `recovery`: висновок

`verifyUpgradeToken` відмовляє сесії з `pending === true` або `auth.recovery`
(`ws-session-auth.ts:89-91`), а `wsSessionHandler` на повідомленнях цього не перевіряє. Шляхи, що
пишуть ці стани, не переводять у них уже відкрите з'єднання:

- вхід із другим кроком MFA створює **новий** `sessionId`;
- підготовка `pending` (`request-session.ts`, `planRecord`) пише запис під `plan.sessionId`
  запланованої сесії і не змінює наявний запис;
- вхід через recovery-код (`mfa-sign-in.ts`) додатково ротує токен (`updateIfSessionToken`), тож
  старі сесії відкликаються;
- `main-service.ts:127` лише формує поле `recovery` у HTTP-відповіді і нічого не пише.

Тому ця різниця між upgrade і перевіркою повідомлень лишається поза feat-274. Висновок ґрунтується
на читанні коду; під час реалізації його достатньо перепідтвердити і послатися на нього в
`progress.md`.

## Що свідомо не входить

- Знімок даних сесії у `WsContext` (див. «Рішення»).
- Звуження `WsContext.userData: UserConnection | null` до non-null. Диспетчер уже отримує
  `userData: UserConnection` (`ws-api-dispatcher.ts:30`), але зміна типу зачепить
  `support-controller.ts`, `ws-permission-guard.ts` і правило ESLint
  `no-unnecessary-condition`. Окрема задача.
- Ключі сесії в redact логера: `userData.userToken` — наявна поведінка поза цією задачею.
- Внутрішня презентація `docs/presentations/PRESENTATION-CONTEXT.html` (рядки 481–666) зі старими
  сигнатурами: це історичний матеріал, не оновлюється.
