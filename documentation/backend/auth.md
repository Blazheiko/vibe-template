# Автентифікація

Ця сторінка описує, як бекенд впізнає користувача: сесії в Redis з HMAC-підписаною cookie, способи входу, як залогінити й розлогінити користувача з коду, авторизацію WebSocket і ролі. Захист трафіку (rate limiting, CSRF, CORS, CSP, проксі) описано на сторінці [Безпека](/backend/security), вхід через Google, GitHub та інші — на сторінці [Вхід через соцмережі](/backend/oauth).

## Коротко на прикладі: що відбувається після входу

Цей ланцюжок можна пройти в браузері (DevTools → Network) або через curl, див. [Перший сценарій](/guide/getting-started#_6-першии-сценаріи-від-входу-до-виходу).

1. **`GET /api/main/init`** без cookie. Сервер створює гостьову сесію в Redis, ставить cookie `uapi` і повертає `401` з `csrfToken`.
2. **`POST /api/auth/login`** з email, паролем і заголовком `x-csrf-token`. Сервер перевіряє пароль, прив'язує сесію до користувача і оновлює cookie:

    ```text
    Set-Cookie: uapi=<…>; Path=/; Expires=…; HttpOnly; Max-Age=86400; SameSite=Lax
    ```

    Неправильний пароль дає `401 {"message":"Invalid email or password","code":"unauthorized"}`, а після 10 невдалих спроб поспіль з однієї адреси сервер відповідає `429` із заголовком `Retry-After: 60` (перевірено з налаштуваннями за замовчуванням; ліміти описано нижче).

3. **Кожен наступний запит** несе cookie автоматично. Middleware `session_web` знаходить сесію в Redis, звіряє її `userToken` з `users.session_token` у БД (див. [Відкликання сесій](#відкликання-сесіи)) і знає, хто ви. `GET /api/main/init` тепер повертає `200` з даними користувача, `wsToken` і новим `csrfToken`.
4. **Захищені маршрути.** `auth_guard` пропускає лише сесію з користувачем (інакше `401`), `admin_guard` — лише роль `admin` (інакше `403 Admin access required`).
5. **`POST /api/auth/logout`** видаляє сесію з Redis. Стара cookie більше нічого не відкриває, `init` знову дає `401`. `logout-all` ротує `users.session_token`, чим відкликає всі сесії користувача (вихід на всіх пристроях), і видаляє їхні записи з Redis.

Що лежить у Redis після такого сценарію (ключі з префіксом `REDIS_PREFIX`):

```text
uwebsocket:session:<userId>:<sessionId>          сесія залогіненого користувача
uwebsocket:session:anon_session:<sessionId>      гостьова сесія, лише якщо вона зберігає дані (OAuth state)
uwebsocket:auth:throttle:login_ip:127.0.0.1      лічильник спроб входу з IP
uwebsocket:auth:ws:<token>                       одноразовий WebSocket-токен (60 с)
```

Звичайна гостьова сесія (до входу) в Redis не пишеться: вона живе в підписаній cookie (див. [Анонімна сесія](#анонімна-сесія)).

Нижче описано формат cookie, підпис, ротацію і решту механізмів.

## Вхід і вихід у коді

Розробнику не треба працювати з cookie, Redis чи підписами напряму. У кожному HTTP-контексті є два об'єкти: `context.auth` (хто користувач, вхід і вихід) і `context.session` (дані поточної сесії). Їх заповнює middleware `session_web` (або `session_api`), тож маршрут має стояти в групі з ним. Типи — `Auth` і `Session` у [`vendor/types/types.d.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/types/types.d.ts), реалізація — [`session-handler.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/session/session-handler.ts).

### `context.auth`

| Метод                      | Повертає           | Що робить                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check()`                  | `boolean`          | `true`, якщо в сесії є `userId`, тобто користувач залогінений. Те саме перевіряє `auth_guard`.                                                                                                                                                                                                                                                                                                                                                 |
| `getUserId()`              | `string \| null`   | id користувача з сесії рядком або `null` для гостя. Для запиту до БД перетворіть на `BigInt(userId)`.                                                                                                                                                                                                                                                                                                                                          |
| `login(userId, userToken)` | `Promise<boolean>` | **Логінить** користувача: видаляє поточну сесію (гостьову чи іншого користувача), створює нову з новим `sessionId` і CSRF-токеном, ставить cookie у відповідь. `userId` — `String(user.id)`, `userToken` — `user.sessionToken` з таблиці `users`. Якщо будь-який аргумент `undefined`, нічого не робить і повертає `false`. Помилку Redis кидає далі.                                                                                          |
| `logout()`                 | `Promise<boolean>` | **Розлогінює** на цьому пристрої: видаляє поточну сесію і видає нову гостьову з новим CSRF-токеном.                                                                                                                                                                                                                                                                                                                                            |
| `logoutAll()`              | `Promise<number>`  | Виходить на **всіх** пристроях: видаляє записи всіх сесій користувача, повертає їх кількість і видає нову гостьову сесію. Сама по собі лише чистить Redis; відкликання забезпечує ротація `users.session_token`, яку маршрут `logout-all` робить у `authService.logoutAll` **перед** цим викликом. Для гостя повертає `0`. Якщо не встиг за дедлайн, кидає помилку, яка стає `503` (див. [Redis як джерело істини](#redis-як-джерело-істини)). |

Після `login`, `logout` і `logoutAll` об'єкти `context.auth` і `context.session` у тому ж запиті вже дивляться на **нову** сесію: `getUserId()` одразу повертає нового користувача, а `context.session.sessionInfo.data.csrfToken` — новий токен, який треба віддати клієнту.

### `context.session`

| Член                      | Що робить                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sessionInfo`             | Поточна сесія `{ id, data, createdAt, updatedAt? }` або `null`. У `data` лежать `userId`, `userToken`, `csrfToken`, `wsToken` і ваші власні поля.                  |
| `updateSessionData(data)` | **Зливає** `data` з наявними даними сесії і зберігає в Redis. Так OAuth зберігає `oauthState` між редиректом і callback. Щоб прибрати поле, передайте `undefined`. |
| `changeSessionData(data)` | **Замінює** дані сесії повністю. Обережно: без `userId`/`userToken`/`csrfToken` у новому об'єкті користувач фактично розлогіниться, а CSRF перестане працювати.    |
| `destroySession()`        | Видаляє поточну сесію з Redis без видачі нової. Для виходу користуйтеся `auth.logout()`, який ще й видає гостьову сесію та cookie.                                 |
| `destroyAllSessions`      | У HTTP-контексті не заповнюється і повертає `0`. Щоб вийти на всіх пристроях, використовуйте `auth.logoutAll()`.                                                   |

### Приклад: свій спосіб входу

Типова схема — сервіс знаходить користувача, перевіряє облікові дані й викликає `auth.login`. Так влаштовано [`auth-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/auth-service.ts) (функція `buildAuthSuccess`, яка ще й видає `wsToken`); нижче спрощений варіант:

```ts
import type { Auth, Session } from '#vendor/types/types.js'

async function signIn(auth: Auth, session: Session, email: string, password: string) {
    const user = await userRepository.findByEmail(email)
    if (user === undefined || !(await validatePassword(password, user.password))) {
        return Result.err(unauthorized('Invalid email or password'))
    }

    // нова сесія, нова cookie, новий CSRF-токен
    await auth.login(String(user.id), user.sessionToken)

    return Result.ok({
        user: userTransformer.serialize(user),
        csrfToken: session.sessionInfo?.data.csrfToken,
    })
}
```

Контролер передає в сервіс `context.auth` і `context.session` і повертає результат. Новий `csrfToken` обов'язково віддайте клієнту: старий після входу більше не приймається (`403 token_mismatch`).

### Приклад: вихід

```ts
async logout(context: HttpContext<EmptyFormInput>): Promise<LogoutResponse> {
    await context.auth.logout()
    return { status: 'success', csrfToken: context.session.sessionInfo?.data.csrfToken }
}
```

Реальний [`auth-controller.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/controllers/http/auth/auth-controller.ts) робить те саме через `authService.logout(context.auth, context.session)` і обробляє помилки через `Result`. Вихід на всіх пристроях — `authService.logoutAll`, який ще й надсилає push-сповіщення безпеки.

### Перевірити, хто робить запит

```ts
async getProfile(context: HttpContext): Promise<ProfileResponse> {
    const userId = context.auth.getUserId()
    if (userId === null) {
        // сюди не дійде, якщо маршрут закрито auth_guard
        context.responseData.status = 401
        return { status: 'error', message: 'Unauthorized' }
    }
    const user = await userRepository.findById(BigInt(userId))
    // ...
}
```

Зазвичай перевірку робить не контролер, а `auth_guard` на маршруті (див. [Middleware](/backend/middlewares)). Тоді в контролері `getUserId()` гарантовано не `null`.

::: warning WebSocket
У WS-контексті `context.auth` і `context.session` дорівнюють `null`: користувач визначається під час підключення, а в обробнику доступний `context.userData`. Див. [Авторизація WebSocket](#авторизація-websocket).
:::

## Сесії

### Формат cookie

Сесію створює і перевіряє [`session-handler.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/session/session-handler.ts), а підпис робить [`token-handler.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/session/token-handler.ts).

- Значення до підпису: `<userToken>.<sessionId>`. Для анонімної сесії, збереженої в Redis, замість `userToken` стоїть рядок `anon_session`. Анонімна сесія без Redis має власний формат — див. [Анонімна сесія](#анонімна-сесія).
- `sessionId` генерується через `crypto.randomUUID()`.
- Підпис: HMAC-SHA256 з ключем `APP_KEY`, hex-рядок обрізаний до 32 символів. Підпис дописується через крапку, а результат кодується в base64: `base64("<userToken>.<sessionId>.<signature>")`.
- Під час перевірки підписи порівнюються через `crypto.timingSafeEqual`. Токен має складатися рівно з 3 частин, а `userToken` має відповідати шаблону `^[a-zA-Z0-9_-]{10,}$`.
- Якщо `APP_KEY` не задано, він коротший за 32 символи або дорівнює `your-secret-key` чи `change-me`, модуль кидає помилку під час завантаження, і сервер не стартує.

Ім'я та атрибути cookie задає [`config/session.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/session.ts):

| Параметр                     | Значення                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Ім'я                         | `__Host-uapi`, якщо `SESSION_COOKIE_HOST_PREFIX` увімкнено (за замовчуванням вмикається, коли `appConfig.isProductionLike`), інакше `uapi` |
| `path` / `httpOnly`          | `/` / `true`                                                                                                                               |
| `secure`                     | `true` для будь-якого `APP_ENV`, крім `local`                                                                                              |
| `sameSite`                   | `Lax`                                                                                                                                      |
| TTL (`age`, `maxAge`, Redis) | 24 години (`duration('24h')`) для сесії користувача                                                                                        |
| TTL анонімної сесії          | `SESSION_ANON_TTL` (`anonAge`), за замовчуванням `2h`: і для cookie, і для анонімної сесії в Redis                                         |

Поки триває перехід на нове ім'я, [`resolve-session-cookie.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/session/resolve-session-cookie.ts) спершу шукає активне ім'я cookie, а потім застаріле `uapi`. Якщо знайдено лише застаріле ім'я, [`delete-legacy-session-cookie.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/session/delete-legacy-session-cookie.ts) надсилає `Set-Cookie`, який видаляє стару cookie. Під час старту [`validate-runtime-config.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/start/validate-runtime-config.ts) перевіряє, що при `__Host-` префіксі cookie має `Secure=true`, а `APP_URL` починається з `https://`.

### Анонімна сесія

Запит без cookie (або з невалідною чи простроченою) отримує анонімну сесію з CSRF-токеном — без запису в Redis (feat-057). Інакше кожен запит бота до `main/init` залишав би в Redis сесію на добу.

- Cookie: `base64("anon-v1.<sessionId>.<csrfToken>.<issuedAt>.<signature>")`, підпис — той самий HMAC з `APP_KEY`. Префікс `anon-v1` розділяє підписи: cookie сесії користувача не перевіряється як анонімна і навпаки.
- Дійсна, поки з `issuedAt` минуло менше `SESSION_ANON_TTL`. Коли їй більше 15 хвилин, сервер видає її знову з новим `issuedAt` і тим самим `sessionId` та токеном (ковзний строк дії, лише `Set-Cookie`).
- Повторно видана анонімна cookie проходить ту саму перевірку перед відправкою (`beforeSend`), що й cookie сесії в Redis: якщо тим часом інший запит цієї сесії виконав вхід (вхід лишає маркер `session_superseded:<sessionId>` на 15 хвилин для будь-якої попередньої анонімної сесії) або переніс її в Redis (`session:anon_session:<sessionId>`), повільна відповідь свою cookie не надсилає.
- Запит, що сам переніс сесію в Redis, перед відправкою перевіряє лише маркер входу: власний запис у Redis не заважає його cookie, а вхід, зроблений тим часом, — заважає. Вхід також видаляє запис `anon_session`, якщо паралельний запит устиг його створити.
- Запит, що сам виконав вхід або вихід, свою cookie зберігає. Якщо перевірка не вдалася (Redis недоступний), cookie з відповіді прибирається.
- Cookie, знайдена лише під застарілим ім'ям `uapi`, видається під активним ім'ям одразу, незалежно від віку.
- CSRF працює як раніше: `sessionInfo.data.csrfToken` береться з cookie, `session_web` віддає його в 401/403, `csrf_guard` порівнює його з заголовком.
- Відкликати таку cookie до кінця строку дії не можна. Прав вона не дає: після входу стара анонімна cookie відкриває лише анонімну сесію, а її токен не підходить до сесії користувача.
- Щойно код записує в анонімну сесію дані (`updateSessionData` / `changeSessionData`, напр. OAuth `state`), вона переходить у Redis як `session:anon_session:<sessionId>` з TTL `SESSION_ANON_TTL`, а cookie — у формат `anon_session.<sessionId>`.

### Redis як джерело істини

### Відкликання сесій

Запис сесії в Redis доводить лише, що сесію колись видали. Тому відкликання не спирається на видалення ключів (воно може не дійти до Redis), а на `users.session_token` у PostgreSQL ([ADR 0002](https://github.com/Blazheiko/vibe-template/blob/main/docs/adr/0002-session-revocation-via-user-token.md)):

- **Перевірка на кожному автентифікованому запиті.** `sessionHandler` (`session_web`, `session_api`), `wsSessionHandler` (кожне WS-повідомлення) і `verifyUpgradeToken` (підключення WS) порівнюють `userToken` сесії з актуальним `users.session_token`, прочитаним із БД без кешу (одне читання за первинним ключем). Збіг — сесія діє; розбіжність або видалений користувач — сесія вважається відкликаною: запит стає анонімним (`401` на `auth_guard`), запис у Redis прибирається за можливості. Анонімні сесії без користувача цієї перевірки не мають.
- **Fail-closed, дедлайн і скасування.** Читання обмежене `SESSION_TOKEN_CHECK_TIMEOUT_MS` (за замовчуванням 2000 мс, див. [Конфігурацію](/backend/configuration)): БД, яка прийняла запит і не відповідає, дає `503`, а не запит, що чекає без кінця. Дедлайну в коді застосунку немає: читання йде через окремий пул з 5 зʼєднань ([`session-check-db.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/session-check-db.ts)), у якого `statement_timeout` дорівнює дедлайну, тож сервер сам скасовує запит (`57014`) і слот не лишається зайнятим. Якщо сервер не відповідає взагалі (розрив мережі), через `timeout + 500 мс` спрацьовує `query_timeout` драйвера: зʼєднання знищується, слот звільняється. Окремий пул потрібен, бо `statement_timeout` — властивість зʼєднання і на основному пулі обмежив би всі запити застосунку; побічно він ізолює автентифікацію від довгих бізнес-запитів. Після помилки `pg-pool` відкриває нове зʼєднання, тож під час тривалого збою кожна перевірка, що вичерпала час, платить за рукостискання (кількість обмежена розміром пулу). Якщо БД не відповіла, запит **не** обслуговується за одним записом Redis: HTTP відповідає `503 service_unavailable` з `Retry-After: 1` (без тексту драйвера), WS-підключення і повідомлення — також `503`/відмовою. Запис Redis при цьому не видаляється: щойно БД відповідає, та сама cookie знову працює.
- **Три операції відкликають, ротуючи токен у БД першим кроком:** `change-password` (один умовний `UPDATE … WHERE password = <поточний хеш>`, тож із двох паралельних змін з однаковим старим паролем успішна рівно одна, друга отримує `409`), `reset-password` / `reset-phone/complete` і `logout-all`. Поточний клієнт після `change-password` отримує нову сесію вже під новим токеном.
- **`destroyAllSessions` — лише очищення пам'яті.** Його збій (Redis недоступний, вичерпано дедлайн) логується й не змінює результат: записи, що лишилися, уже відхиляються перевіркою, а решту прибирає TTL. Після збою Redis перший же запит зі старою cookie дає `401` — повторного очищення не потрібно.
- **Ціна.** +1 читання за первинним ключем на автентифікований запит і WS-повідомлення. Кеш цього значення можливий, але свідомо не вводився: він додав би вікно, у якому відкликана сесія ще діє (збій інвалідації, гонка читання й інвалідації).

### Що таке `userToken`

`userToken` — це колонка `users.session_token` (`nanoid()`, 21 символ, унікальна, задається при створенні користувача). Це не сесія і не секрет для входу, а **постійний простір імен сесій користувача** в Redis:

- усі сесії одного користувача на всіх пристроях лежать під `session:<userToken>:*`, тож `logoutAll` знаходить їх одним `SCAN MATCH` без окремого індексу «користувач → сесії»;
- зміна пароля, скидання пароля (за email і за SMS) і `logout-all` **замінюють** `session_token` на новий `nanoid()`: сесії зі старим значенням відкликані, навіть якщо їхні ключі ще лежать у Redis (див. [Відкликання сесій](#відкликання-сесіи));
- значення входить у підписану cookie (`<userToken>.<sessionId>.<signature>`), тож сервер одразу знає, де шукати сесію в Redis, а актуальність значення звіряє з БД.

Зберігається воно в PostgreSQL, бо мусить пережити всі сесії: нова сесія після логіну бере `userToken` з рядка користувача, а Redis зберігає лише живі сесії з TTL. Без постійного значення в БД кожен вхід створював би новий простір імен, і `logoutAll` не бачив би сесій з інших пристроїв.

Клієнту `userToken` не потрібен: відповіді з користувачем (`user-transformer.ts`) його не містять. Сам по собі він сесію не відкриває — потрібні ще `sessionId` і підпис `APP_KEY`, — але й світити його в JSON, доступному з JavaScript, немає причин.

Сесії зберігає [`redis-session-storage.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/session/redis-session-storage.ts):

- Ключ має вигляд `session:<userToken|anon_session>:<sessionId>`. Перед кожною операцією `sanitizeRedisKey` перевіряє його: дозволено лише `[a-zA-Z0-9:_*-]`, довжина не більше 86 символів.
- Запис робиться через `SETEX`, читання — через `GETEX ... EX`, з TTL `age` для сесії користувача і `anonAge` для `anon_session`. Тобто кожне читання продовжує життя сесії (ковзний TTL).
- Якщо підпис валідний, але ключа в Redis немає, видається нова анонімна сесія (у cookie, без запису).
- `destroyAllSessions` (виклик `logoutAll`) знаходить ключі через `SCAN MATCH session:<userToken>:*` порціями по 100, а не через `KEYS`.
- **Межа `logoutAll`.** Увесь цикл `SCAN`/`DEL` обмежений дедлайном `REDIS_LOGOUT_ALL_DEADLINE_MS` (2000 мс), що рахується від його початку. Перед кожним `await` обчислюється залишок бюджету, і команда очікується не довше `min(залишок, REDIS_COMMAND_TIMEOUT_MS)`. Успіх (`deletedCount`) повертається **лише** якщо `SCAN` дійшов до курсора `0`, тобто всі сесії видалено. Якщо дедлайн вичерпано або команда отримала `RedisUnavailableError` — `503 service_unavailable` з `Retry-After: 1`, без `deletedCount`. Уже видалені сесії лишаються видаленими (`DEL` ідемпотентний), повторний виклик дочищає решту. Це поведінка сховища; `503` тут означає лише, що **записи** не вдалося видалити: через `authService.logoutAll` сесії вже відкликані ротацією `users.session_token`, а записи, що лишилися, дочищаються при наступному повному відкликанні або спливають за TTL:
    - **поточна сесія видаляється останньою**, лише після курсора `0`. Клієнт, який викликає `auth.logoutAll()` напряму (без ротації токена), після `503` лишається автентифікованим і може повторити запит; маршрут `logout-all` так не працює;
    - **курсор `SCAN` зберігається** в `logout_all:cursor:<userToken>:<sessionId>` (TTL 600 с) після кожної порції, і повтор `logoutAll` з тієї самої сесії продовжує з нього, а не з `0`, тому на великій базі повтори просуваються. Сесії, створені між спробами позаду збереженого курсора, продовжений обхід не бачить;
    - **повне відкликання** (скидання пароля, виклик без поточної сесії) завжди обходить базу з `0` і курсор не читає й не пише: прогрес перерваного `logoutAll`, який пропустив свою сесію, не може приховати її від відкликання.

Middleware `session_web` ([`session-web.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/middlewares/ws/session-web.ts)) читає cookie, а `session_api` ([`session-api.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/middlewares/http/session-api.ts)) бере той самий підписаний токен із заголовка `Authorization: Bearer <token>`. Cookie нової сесії видається одразу, а cookie незміненої сесії в Redis — повторно не частіше ніж раз на годину, щоб продовжити строк дії. Момент оновлення визначає окремий ключ `session_cookie_refresh:<sessionId>` (`SET NX EX 3600`): запис сесії при цьому не переписується, тож оновлення не може відновити сесію, яку інший запит щойно видалив. Нова сесія користувача ставить цей ключ одразу; якщо запис ключа не вдається, сесія все одно створюється (помилка лише логується), і cookie просто буде оновлено раніше. Перед відправкою відповіді (`context.session.beforeSend` після хендлера) сервер перевіряє, що сесія, чию cookie повторно видає запит, ще існує: повільна відповідь не повертає браузеру cookie сесії, яку тим часом замінив інший запит (зміна пароля, logout-all). Запити, що самі змінили сесію (login, logout), свою cookie зберігають. Якщо ця перевірка не вдається (Redis недоступний), cookie з відповіді прибирається, а відповідь хендлера лишається без змін. Залишковий ризик: браузер може отримати відповіді в іншому порядку, ніж сервер їх відправив, і зберегти cookie вже видаленої сесії. Тоді наступний запит отримує нову анонімну сесію (користувач входить знову); прав видаленої сесії він не отримує.

### Ротація

- `auth.login(userId, userToken)` видаляє попередню сесію з Redis (автентифіковану або збережену анонімну) і створює нову з новим `sessionId` та новим CSRF-токеном. Стара cookie сесії з Redis після цього відкриває нову анонімну сесію з іншим токеном, тож мутація зі старим токеном отримує `403 token_mismatch`. Анонімна cookie без Redis лишається дійсною до кінця свого строку, але відкриває лише анонімну сесію; токен з неї не підходить до сесії користувача. Це захищає від session fixation.
- `auth.logout()` видаляє поточну сесію і видає нову анонімну (у cookie).
- `auth.logoutAll()` видаляє записи всіх сесій користувача і видає нову анонімну (у cookie). Відкликання — це ротація `users.session_token` у `authService.logoutAll`, яка йде першою.
- Після `login`/`logout`/`logoutAll` хелпери `context.session.*` у тому ж запиті працюють уже з новою сесією.
- Ротація лише CSRF-токена без зміни `sessionId` не використовується: зміна автентифікації завжди означає новий `sessionId`.

Коли змінюється сесія (аудит переходів автентифікації):

| Потік                                        | Що відбувається з сесією                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Вхід (email/пароль, телефон), OAuth-callback | `auth.login`: новий `sessionId` і токен, попередня сесія видалена                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `register/phone/complete-profile`            | `auth.login` після створення користувача                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `register/email`                             | анонімна сесія видаляється; вхід — після підтвердження email                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `register/phone/confirm`, `verify-email`     | сесія не змінюється: лише підтвердження коду або адреси, права не змінюються; токен пошти споживається атомарно в одній транзакції з її підтвердженням                                                                                                                                                                                                                                                                                                                                   |
| `change-password`                            | `authService.renewSession`: новий `sessionId`, CSRF- і WS-токен для того самого користувача; відповідь `sessionRenewed: true` з `csrfToken`, `wsUrl`, `wsToken`, і клієнт перепідключає WebSocket. Пароль і новий `users.session_token` пишуться одним умовним `UPDATE`: усі інші сесії відкликані, а нова видається вже зі свіжим токеном. Якщо видача нової сесії падає, відповідь лишається успіхом з `sessionRenewed: false` (попередня сесія вже відкликана — клієнт входить знову) |
| `reset-password`, `reset-phone/complete`     | анонімний запит; токен скидання (email) споживається в одній транзакції зі зміною пароля й ротацією `users.session_token` (це і є відкликання): із двох паралельних запитів з одним посиланням успішний один, а збій після запису відкочує все, і посилання лишається придатним; `destroyAllSessions` виконується після коміту, лише чистить записи в Redis, і його збій не зупиняє скидання                                                                                             |
| `link-phone/confirm`, `link-email/*`         | сесія не змінюється: додається ідентифікатор, права не змінюються                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Зміна ролі                                   | ендпоінта немає; `admin_guard` читає роль із бази на кожному запиті                                                                                                                                                                                                                                                                                                                                                                                                                      |

```mermaid
sequenceDiagram
    participant B as Браузер
    participant S as session_web
    participant R as Redis
    B->>S: Cookie __Host-uapi=base64(...)
    alt анонімна cookie (anon-v1), підпис і строк дійсні
        S->>S: verifyAnonSessionToken — сесія з cookie, Redis не потрібен
    else cookie сесії в Redis
        S->>S: verifySignedToken (HMAC, timingSafeEqual)
        S->>R: GETEX session:token:sid EX ttl
        R-->>S: SessionInfo або нічого
    end
    opt сесії немає або підпис невалідний
        S->>S: нова анонімна сесія (без запису в Redis)
    end
    S-->>B: Set-Cookie, якщо сесія нова або строк дії треба продовжити
```

## Способи входу

Маршрути групи `auth` оголошено в [`http-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts). Група має middleware `session_web` і `csrf_guard` та rate limit 10 запитів на хвилину з IP на кожен маршрут групи (окремі маршрути мають суворіші власні ліміти). Контролери: [`auth-controller.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/controllers/http/auth/auth-controller.ts) і [`oauth-controller.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/controllers/http/auth/oauth-controller.ts).

- **Email і пароль**: `POST /auth/register/email` для реєстрації та `POST /auth/login` для входу. Схема входу [`login.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/auth/login.ts) приймає або `email`, або `identifier`, разом із `password` (8–32 символи). Паролі хешує `hashPassword` з `metautil` ([`auth-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/auth-service.ts)). Є також `forgot-password`, `reset-password`, `verify-email`, `resend-verification-email`, `change-password`, `link-email/start`.
- **Телефон і SMS**: `register/phone/start`, `register/phone/confirm`, `register/phone/complete-profile`, `reset-phone/start`, `reset-phone/complete`, `link-phone/start`, `link-phone/confirm`. Вмикається через `AUTH_PHONE_ENABLED` ([`config/auth.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/auth.ts)). OTP-коди зберігаються як HMAC-SHA256 з ключем `AUTH_OTP_HMAC_KEY` (або `APP_KEY`, якщо перший не задано) ([`otp-verification-hash.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/otp-verification-hash.ts)). Якщо телефонний вхід увімкнено, а ключ коротший за 32 символи, сервер не стартує.
- **Соцмережі (OAuth)**: Google, Facebook, GitHub і GitLab через бібліотеку `arctic`. Що потрібно налаштувати і як додати провайдера — на сторінці [Вхід через соцмережі](/backend/oauth).

Провайдер SMS обирається через `AUTH_SMS_PROVIDER`. Валідатор runtime-конфігурації забороняє `AUTH_SMS_PROVIDER=fake` в середовищах production-like і вимагає явно задати `AUTH_SMS_PROVIDER_ALLOW_FAKE=true` та `AUTH_FAKE_SMS_CODE`.

## Авторизація WebSocket

1. Автентифікований клієнт викликає `GET /main/update-ws-token` (`auth_guard`). [`generate-ws-token-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/generate-ws-token-service.ts) кладе в Redis ключ `auth:ws:<token>` з TTL 60 с і даними `{ sessionId, userId, userToken }`.
2. Клієнт відкриває `/<pathPrefix>/websocket` і передає токен першим елементом `Sec-WebSocket-Protocol`. `handleUpgrade` у [`ws-handlers.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/network/ws-handlers.ts) перевіряє формат токена: довжина `accessTokenLength`, лише символи `[a-zA-Z0-9]`. Якщо формат невірний, сервер відповідає `401`.
3. [`ws-session-auth.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/websocket/ws-session-auth.ts) (`verifyUpgradeToken`) читає токен, знаходить сесію `session:<userToken>:<sessionId>` і перевіряє, що `userId` у сесії збігається з `userId` у токені, і звіряє `userToken` з `users.session_token` (відкликана сесія → відмова; БД не відповіла → `503`, а не доступ за одним записом Redis). `refreshToken` продовжує TTL токена до 120 с, а `revokeToken` видаляє токен під час закриття з'єднання.
4. Кожне повідомлення проходить через `wsSessionHandler`, який так само звіряє `userToken` з БД (недоступна БД → повідомлення не обробляється, клієнт отримує `503`-повідомлення). Якщо сесії немає, вона відкликана або в ній немає `userId`, клієнт отримує unauthorized-повідомлення, а з'єднання закривається з кодом `4001`.

## Ролі: `auth_guard` та `admin_guard`

- [`auth-guard.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/middlewares/core/auth-guard.ts) повертає `401 unauthorized`, якщо `auth.check()` хибне.
- [`admin-guard.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/middlewares/admin-guard.ts) завантажує користувача з БД і повертає `403 forbidden`, якщо `role !== 'admin'`. Адмінські групи підключають `["session_web", "csrf_guard", "auth_guard", "admin_guard"]`.
