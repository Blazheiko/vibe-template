# Безпека

Ця сторінка описує, як бекенд захищає HTTP- та WebSocket-трафік: обмеження частоти запитів, CSRF, CORS, заголовки безпеки та CSP, визначення IP за проксі. Як користувач входить і як влаштовані сесії, описано на сторінці [Автентифікація](/backend/auth). Усе нижче описано за поточним кодом у `packages/backend/src`. Загальний порядок обробки запиту — [Життєвий цикл запиту](/backend/request-lifecycle).

## Обмеження частоти запитів

Ліміти працюють на двох рівнях, і в них різні задачі.

- **Ліміт захищає процес від частих тяжких операцій** (парсинг тіла, middleware, запити до БД, AI) → `rateLimit` на маршруті чи групі або глобальний ліміт у [`config/rate-limit.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/rate-limit.ts). Лічильник у пам'яті процесу, кожен інстанс рахує окремо.
- **Ліміт стосується чутливої дії** (вхід, реєстрація, SMS, скидання й зміна пароля) і має бути спільним для всіх інстансів → політика в [`config/throttle-policies.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/throttle-policies.ts) і виклик `consumeAuthThrottle(policy, key)` у сервісі. Лічильник у Redis.

```
HTTP API:  L1 (memory) → ліміт маршруту (memory) → handler → auth-політики (Redis)
WebSocket: upgrade рівень 1 (memory) → рівень 2 (Redis) → auth (onUpgrade) → ліміти повідомлень (memory)
```

### Локальні ліміти (у пам'яті, на інстанс)

| Ліміт                  | Де задано                                                                                                                             | Ключ         | Алгоритм     | Вікно / максимум                                                       | Змінна оточення            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------ | ---------------------------------------------------------------------- | -------------------------- |
| L1 — усі API-запити    | [`config/rate-limit.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/rate-limit.ts)              | IP           | fixed-window | 60 с / 600                                                             | `HTTP_GLOBAL_RATE_LIMIT_*` |
| Маршрут або група HTTP | `rateLimit` у [`http-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts) | IP + маршрут | sliding-log  | за маршрутом, напр. група `auth` 60 с / 10, `forgot-password` 60 с / 3 | — (у коді)                 |
| WS upgrade, рівень 1   | [`config/rate-limit.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/rate-limit.ts)              | IP           | sliding-log  | 60 с / 120                                                             | `WS_UPGRADE_RATE_LIMIT_*`  |
| WS-повідомлення        | `rateLimit` у [`ws-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/ws-routes.ts)     | IP + маршрут | sliding-log  | 60 с / 60–120                                                          | — (у коді)                 |

- **L1** ([`http-rate-limit.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/rate-limit/http-rate-limit.ts)) рахує кожен API-запит рівно один раз: маршрути, API-404, preflight `OPTIONS` і звичайні HTTP-запити на `/<API_PATH_PREFIX>/websocket`. Статика не рахується. На успішній відповіді L1 заголовків не пише; на 429 віддає `X-RateLimit-*` і `Retry-After`, і ліміт маршруту тоді не перевіряється.
- **Ліміт маршруту** має пріоритет над лімітом групи. Відповідь містить `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`; перевищення — `429 rate_limited` з `Retry-After`; помилка лічильника — `503 rate_limit_unavailable` (fail-closed).
- **Чому синхронно і в пам'яті.** У [`server.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/server.ts) обидві HTTP-перевірки стоять **до** реєстрації `res.onData()`: якщо там буде `await`, uWS може доставити тіло малого POST раніше, ніж його почнуть читати, і запит зависне. Redis асинхронний, тому для цих лімітів не підходить. До того ж їхня задача — захистити процес, а не тримати точний бюджет у кластері.
- **Бюджет при N інстансах** дорівнює N × максимум. Це свідомий вибір: кожен процес захищає себе сам. Ліміт на вході за потреби дає reverse proxy, див. [Розгортання](/backend/deployment#rate-limit-на-edge).
- **WS-повідомлення** рахуються за IP, а не за з'єднанням: інакше бюджет можна множити, відкриваючи нові з'єднання.

**Лічильник** ([`rate-limit-store.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/rate-limit/rate-limit-store.ts)):

- **Відхилені спроби квоту не витрачають і не зберігаються.** Тому `Retry-After` точний. Стан на ключ обмежений: sliding log довжиною не більше `max`, для L1 один лічильник.
- **Межа ключів жорстка, 100 000.** На новий ключ перевіряються максимум 64 найстаріші ключі; якщо місця немає, витісняється найстаріший. Повний GC раз на 60 с.

::: warning Переповнення store
Коли ключів більше за межу, **строгість квот не гарантується**: FIFO-витіснення може скинути навіть активний лічильник. Так пам'ять лишається обмеженою під атакою з великої кількості IP. Витіснення пише `warn` не частіше разу на хвилину.
:::

### Спільні ліміти (Redis)

Усі спільні ліміти описані в реєстрі [`config/throttle-policies.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/throttle-policies.ts); стовпці таблиці відповідають полям `ThrottlePolicy`. Сервіси передають лише політику й ключ — `consumeAuthThrottle(throttlePolicies.loginIp, ip)` ([`auth-throttle-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/auth-throttle-service.ts)). Fixed-window політики пишуть ключ `auth:throttle:<scope>:<key>` (Lua `INCR` + `PEXPIRE` лише на першій спробі, тож вікно відраховується від першої спроби і відмови його не продовжують). `wsUpgradeShared` — sliding log на ZSET з ключем `rl:upgrade:<ip>` ([`redis-sliding-log.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/rate-limit/redis-sliding-log.ts)), час береться з Redis.

| Політика                  | Операція                                                      | Ключ            | Алгоритм     | Вікно / максимум                       | Змінна оточення                                               | При відмові Redis                        | Скидання     |
| ------------------------- | ------------------------------------------------------------- | --------------- | ------------ | -------------------------------------- | ------------------------------------------------------------- | ---------------------------------------- | ------------ |
| `loginIp`                 | вхід                                                          | IP              | fixed-window | 15 хв / 20                             | `AUTH_LOGIN_MAX_ATTEMPTS_PER_IP`, `AUTH_LOGIN_WINDOW_SECONDS` | відхилити                                | —            |
| `loginIdentifier`         | вхід                                                          | email / телефон | fixed-window | 15 хв / 40                             | `AUTH_LOGIN_MAX_ATTEMPTS_PER_IDENTIFIER`                      | відхилити                                | після успіху |
| `changePasswordUser`      | зміна пароля                                                  | користувач      | fixed-window | 15 хв / 10                             | `AUTH_CHANGE_PASSWORD_*`                                      | відхилити                                | після успіху |
| `forgotPasswordIp`        | лист скидання пароля                                          | IP              | fixed-window | 1 год / 10                             | `AUTH_FORGOT_PASSWORD_MAX_REQUESTS_PER_IP_PER_HOUR`           | загальна відповідь, лист не надсилається | —            |
| `forgotPasswordEmail`     | лист скидання пароля                                          | email           | fixed-window | 1 год / 3                              | `AUTH_FORGOT_PASSWORD_MAX_REQUESTS_PER_EMAIL_PER_HOUR`        | загальна відповідь, лист не надсилається | —            |
| `resetPasswordIp`         | скидання пароля за токеном                                    | IP              | fixed-window | 1 год / 20                             | `AUTH_RESET_PASSWORD_MAX_ATTEMPTS_PER_IP_PER_HOUR`            | відхилити                                | —            |
| `verifyEmailIp`           | підтвердження email                                           | IP              | fixed-window | 1 год / 20                             | `AUTH_VERIFY_EMAIL_MAX_ATTEMPTS_PER_IP_PER_HOUR`              | відхилити                                | —            |
| `resendVerificationUser`  | повторний лист підтвердження                                  | користувач      | fixed-window | 1 год / 3                              | `AUTH_RESEND_VERIFICATION_MAX_PER_USER_PER_HOUR`              | відхилити                                | —            |
| `loginUnverifiedResend`   | лист підтвердження після входу в непідтверджений акаунт       | користувач      | fixed-window | 5 хв / 1                               | `AUTH_LOGIN_UNVERIFIED_RESEND_INTERVAL_MS`                    | не надсилати лист (вхід усе одно 401)    | —            |
| `registerEmailIp`         | реєстрація email                                              | IP              | fixed-window | 1 год / 10                             | `AUTH_EMAIL_REGISTER_MAX_ATTEMPTS_PER_IP_PER_HOUR`            | відхилити                                | —            |
| `registerEmailIdentifier` | реєстрація email                                              | email           | fixed-window | 1 год / 3                              | `AUTH_EMAIL_REGISTER_MAX_ATTEMPTS_PER_EMAIL_PER_HOUR`         | відхилити                                | —            |
| `registerPhoneIp`         | реєстрація телефоном                                          | IP              | fixed-window | 1 год / 10                             | `AUTH_SMS_MAX_SENDS_PER_IP_PER_HOUR`                          | відхилити                                | —            |
| `smsSendPhone`            | відправка SMS (реєстрація, скидання, прив'язка — один бюджет) | телефон         | fixed-window | 1 год / 3                              | `AUTH_SMS_MAX_SENDS_PER_PHONE_PER_HOUR`                       | відхилити                                | —            |
| `confirmPhoneIp`          | підтвердження телефону                                        | IP              | fixed-window | 1 год / 20                             | `AUTH_SMS_MAX_CONFIRM_ATTEMPTS_PER_IP_PER_HOUR`               | відхилити                                | —            |
| `resetPhoneIp`            | скидання пароля телефоном                                     | IP              | fixed-window | 1 год / 10                             | `AUTH_SMS_MAX_SENDS_PER_IP_PER_HOUR`                          | відхилити                                | —            |
| `confirmResetPhoneIp`     | підтвердження скидання телефоном                              | IP              | fixed-window | 1 год / 20                             | `AUTH_SMS_MAX_CONFIRM_ATTEMPTS_PER_IP_PER_HOUR`               | відхилити                                | —            |
| `linkPhoneIp`             | прив'язка телефону                                            | IP              | fixed-window | 1 год / 10                             | `AUTH_SMS_MAX_SENDS_PER_IP_PER_HOUR`                          | відхилити                                | —            |
| `confirmLinkPhoneIp`      | підтвердження прив'язки телефону                              | IP              | fixed-window | 1 год / 20                             | `AUTH_SMS_MAX_CONFIRM_ATTEMPTS_PER_IP_PER_HOUR`               | відхилити                                | —            |
| `linkEmailTarget`         | прив'язка email                                               | email           | fixed-window | 1 год / 3                              | `AUTH_EMAIL_LINK_MAX_ATTEMPTS_PER_TARGET_PER_HOUR`            | відхилити                                | —            |
| `linkEmailUser`           | прив'язка email                                               | користувач      | fixed-window | 1 год / 3                              | `AUTH_EMAIL_LINK_MAX_ATTEMPTS_PER_USER_PER_HOUR`              | відхилити                                | —            |
| `linkEmailUserCooldown`   | пауза між листами прив'язки                                   | користувач      | fixed-window | `AUTH_EMAIL_LINK_COOLDOWN_SECONDS` / 1 | `AUTH_EMAIL_LINK_COOLDOWN_SECONDS`                            | відхилити                                | —            |
| `wsUpgradeShared`         | WS upgrade, рівень 2                                          | IP              | sliding-log  | 60 с / 60                              | `WS_UPGRADE_SHARED_RATE_LIMIT_*`                              | пропустити, діє рівень 1                 | —            |

`0` у змінній auth-політики — помилка конфігу на старті: захист чутливої дії вимкнути не можна. Вимкнути змінною (`MAX=0`) можна лише `wsUpgradeShared` (`disableable`), напр. для одного інстансу.

Спільні ліміти ходять в окреме з'єднання ([`redis-rate-limit.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/redis-rate-limit.ts)) до того самого Redis-сервера: без offline queue, без повторного надсилання команд і з коротким таймаутом `RATE_LIMIT_REDIS_TIMEOUT_MS`. Основний клієнт сесій тепер теж працює без offline queue і повторів, але з довшим таймаутом `REDIS_COMMAND_TIMEOUT_MS` (див. [Відмова Redis](#відмова-redis)). Таймаут означає «результат невідомий»: Lua могла вже спожити спробу, тому повтору немає.

### Політика входу

- **Рахується кожна допущена спроба**, атомарно і **до** пошуку користувача: так немає гонки «перевірити зараз, порахувати потім», а відсутній акаунт, неправильний пароль чи акаунт без пароля коштують однаково.
- **Однакова відповідь** `401 Invalid email or password` для відсутнього акаунта, неправильного пароля, акаунта без локального пароля (OAuth) і вичерпаного бюджету. Фронтенд у тексті помилки підказує вхід через Google або Facebook.
- **Ключі:** IP і нормалізований ідентифікатор. Ідентифікатор нормалізує та сама функція `resolveLoginKey`, що й пошук користувача (email — нижній регістр, телефон — E.164). Якщо ідентифікатор не нормалізується, рахується лише IP.
- **Поріг за ідентифікатором вищий за IP-поріг**, щоб один атакувальник не міг легко заблокувати чужий акаунт. Блокування не постійне — до кінця 15-хвилинного вікна.
- **Після успішного входу** скидається лише лічильник ідентифікатора; IP-лічильник ні (інакше власний валідний акаунт обнуляв би IP-бюджет).
- **Ризик lockout:** атакувальник з багатьох IP може вичерпати бюджет ідентифікатора і на 15 хв заблокувати вхід у чужий акаунт. Пом'якшення — вищий поріг і коротке вікно.
- Зміна пароля працює за тією ж схемою з бюджетом на користувача.

### Відмова Redis

| Сценарій                                                        | WS upgrade, рівень 2                               | Автентифікація upgrade                                                               | Auth-політики                                                                                               |
| --------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Збій лише з'єднання лімітів (розрив, таймаут; сервер доступний) | пропускається, діє рівень 1, `warn` раз на хвилину | працює через основний клієнт                                                         | відхиляються (fail-closed); `forgot-password` віддає загальну відповідь без листа                           |
| Недоступний Redis-сервер                                        | пропускається, діє рівень 1                        | **не працює**: upgrade швидко відхиляється `503` з `Retry-After: 1` до `res.upgrade` | запит до них не доходить: middleware сесії швидко завершується `503 service_unavailable` з `Retry-After: 1` |

- Пропуск рівня 2 **не** витрачає локальний бюджет удруге: рівень 1 уже спожив спробу цього upgrade.
- Пропуск рівня 2 **не гарантує** WS-з'єднання: перевірка токена й сесії теж іде в Redis. Якщо сесію не знайдено, upgrade відхиляється з `401` до `res.upgrade`.
- **Перевищення бюджету під час відмови:** кожен інстанс рахує лише локально, тож за вікно можливо до N × поріг рівня 1 upgrade з одного IP.
- **Повна недоступність Redis зупиняє не лише ліміти, але швидко.** Основний клієнт сесій ([`redis.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/redis.ts), опції в [`redis-main-options.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/redis-main-options.ts)) працює без offline queue (`enableOfflineQueue: false`), без повторного надсилання (`autoResendUnfulfilledCommands: false`, `maxRetriesPerRequest: 0`) і з таймаутом `REDIS_COMMAND_TIMEOUT_MS` (500 мс); reconnect іде у фоні із затримкою `min(times · 100, 2000)` мс. Обгортка `withRedis` відмовляє одразу без команди, якщо з'єднання не `ready`. Тож запит, що читає сесію, отримує `503 service_unavailable` з `Retry-After: 1` за мілісекунди (розрив) або за час таймауту (підключений, але повільний Redis), а не чекає. Перша ж недоступна команда перериває запит, наступні не виконуються.
- **Ціна відмови від черги:** короткий reconnect теж дає `503`, а не коротку затримку; HTTP-клієнт отримує `Retry-After: 1`.
- **WS-з'єднання під час збою не закриваються:** `ping`/`pong` не залежить від Redis, а прикладне повідомлення отримує відповідь `service_unavailable` зі своїм `event` (див. [WebSocket](/backend/websocket#диспетчер)).
- **Пізнє виконання.** Команду, вже записану в сокет, Redis може виконати навіть після того, як клієнт отримав таймаут. Наслідки обмежені: в одному процесі одне з'єднання, тож порядок записів процесу зберігається; запізнілий `SETEX` при login створить сесію без cookie, яка зникне за TTL; запізнілий `DEL` при logout видалить сесію пізніше, а клієнт, отримавши `503`, повторить вихід.
- Як фіксується інцидент у логах і Sentry — [Observability](/backend/observability#відмова-redis).
- **Після відновлення Redis** спільний лічильник продовжується зі свого стану; спроби, пропущені локально під час відмови, у нього не потрапляють.

### Як додати ліміт

Захист процесу — `rateLimit` на маршруті:

```ts
defineRoute({
    url: '/report/export',
    method: 'post',
    handler: ReportController.export.bind(ReportController),
    rateLimit: { windowMs: 60_000, maxRequests: 5 },
})
```

Чутлива дія — політика в реєстрі, виклик у сервісі й рядок у таблиці вище:

```ts
// config/throttle-policies.ts
exportReportUser: fixedWindow(
  'export_report_user',
  'user',
  readInt('REPORT_EXPORT_MAX_PER_USER_PER_HOUR', 10),
  HOUR_MS,
),

// сервіс
const throttle = await tryInternal(
  () => consumeAuthThrottle(throttlePolicies.exportReportUser, String(userId)),
  'Failed to enforce export throttle',
)
```

## CSRF

Пояснення для початківців — [CSRF простими словами](/guide/csrf).

Використовується модель synchronizer token ([`config/csrf.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/csrf.ts), [`csrf-guard.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/middlewares/csrf-guard.ts), [`csrf-token.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/session/csrf-token.ts)):

- Кожна сесія має `csrfToken`: 32 випадкові байти в кодуванні base64url. Якщо в старій сесії токена немає, він дописується під час наступного завантаження сесії.
- `csrf_guard` перевіряє лише методи `post`, `put`, `patch`, `delete`/`del`. Перевірки йдуть по черзі, і кожна може лише відхилити запит, а не пропустити наступні:
    1. **Fetch Metadata.** `Sec-Fetch-Site: cross-site` → `403` з `reason: fetch_site_cross_site`; невідоме значення → `fetch_site_invalid`. `same-origin`, `same-site`, `none` і відсутній заголовок (старі браузери, не-браузерні клієнти) переходять до наступних перевірок.
    2. **Origin/Referer** (нижче). `Origin: null` і некоректний `Origin` відхиляються одразу, без переходу до `Referer`.
    3. **Токен** у заголовку `x-csrf-token`, порівняння через `timingSafeEqual`.
- `session_web` створює анонімну сесію з токеном ще до `csrf_guard`, тож запит без cookie теж має сесію і має надіслати її токен. Анонімна сесія живе в підписаній cookie і в Redis не пишеться, доки не зберігає дані ([Анонімна сесія](/backend/auth#анонімна-сесія)), тож потік запитів без cookie не заповнює Redis. Це закриває login CSRF: `POST /auth/login` без токена отримує `403 token_mismatch` навіть з правильним `Origin`. Правильний холодний старт — `GET /main/init` → `401` з cookie і `csrfToken` → `POST /auth/login` з цією cookie і токеном. Якщо сесії все ж немає (збій `session_web`), guard відхиляє запит.
- Підтримувана топологія: фронтенд і API на одному origin або на піддоменах одного сайту. З `SameSite=Lax` браузер не надсилає сесійну cookie в cross-site `fetch`, тому розгортання на різних сайтах не підтримується.
- Додатково звіряються `Origin`/`Referer` зі списком `CSRF_ALLOWED_ORIGINS` (точні origin: схема, хост, порт — без шляху і `/` в кінці; некоректний елемент зупиняє старт). У production-like середовищах (`APP_ENV`/`NODE_ENV` = `production`/`prod` або `APP_IS_PRODUCTION=true`) список обов'язковий — без нього сервер не стартує. Поза production порожній список замінюється origin з `APP_URL` і `FRONTEND_URL`; якщо й вони не задані, перевірку списку пройде будь-який коректний origin. Про обидва випадки сервер попереджає під час старту.
- `CSRF_STRICT_ORIGIN` за замовчуванням `true`: небезпечні запити без `Origin` і без `Referer` відхиляються. Браузери завжди надсилають `Origin` для `fetch` з POST/PUT/PATCH/DELETE.
- `CSRF_ENFORCE` за замовчуванням `true`: порушення отримують `403` з кодом `csrf_invalid` і полем `reason` (`fetch_site_cross_site`, `fetch_site_invalid`, `origin_mismatch` або `token_mismatch`; список — `CsrfRejectReason` у `shared/errors`). `CSRF_ENFORCE=false` — режим звітування для діагностики й відкату: порушення лише логуються (`CSRF validation failed`), запит проходить далі; у production-like середовищі сервер попереджає про це під час старту. Змінна читається при старті, тож перемикання потребує перезапуску.
- `session_web` додає `csrfToken` до відповідей, які сформував ланцюжок middleware (401 від `auth_guard`, 403 від `csrf_guard`). Завдяки цьому анонімний клієнт отримує токен для запиту входу.

## CORS

[`config/cors.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/cors.ts) задає налаштування, а `setCorsHeader` у [`server.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/server.ts) їх застосовує:

- `ENABLED_CORS` за замовчуванням дорівнює `false`.
- `CORS_ALLOWED_ORIGINS` — список дозволених origin з точним збігом, без wildcard. `Access-Control-Allow-Origin` відображає `Origin` запиту лише тоді, коли він є в списку. Порожній список забороняє всі крос-доменні запити.
- `Access-Control-Allow-Credentials: true` надсилається лише при `CREDENTIONALS_CORS=true` (назва змінної саме така, з помилкою в слові) і лише для origin зі списку.
- Сервер завжди надсилає `Vary: Origin`. Preflight `OPTIONS` отримує `200` з CORS-заголовками.

## Заголовки безпеки та CSP

[`http-response-handlers.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/network/http-response-handlers.ts) (`setSecurityHeaders`) додає до кожної відповіді — JSON API, помилок, CORS `OPTIONS`, HTML-оболонки SPA і статики — такі заголовки: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` і `Strict-Transport-Security: max-age=31536000; includeSubDomains`, а також CSP за правилами нижче.

Статика ([`static-server.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/static-server.ts)) завантажується в пам'ять під час старту з білого списку розширень, без файлів, що починаються з крапки. Запити з `..`, `%2e%2e`, `\0` або `%00` отримують `400`.

### Content-Security-Policy

Політику будує [`config/csp.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/csp.ts) з функцій [`vendor/utils/network/csp.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/network/csp.ts). Значення заголовків обчислюються **один раз на старті**.

| Відповідь                                            | Політика                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| HTML: `/`, `/index.html`, SPA fallback, і 200, і 304 | повна політика документа (нижче)                                        |
| SVG зі статики, 200 і 304                            | `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'` |
| `/service-worker.js`                                 | **без CSP**                                                             |
| інші JS, CSS, шрифти, картинки                       | без CSP (для підресурсів браузер її ігнорує)                            |
| API JSON, помилки, статичні 400/404, CORS `OPTIONS`  | `default-src 'none'; frame-ancestors 'none'`                            |

Політика документа:

```text
default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none';
form-action 'self'; script-src 'self';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com;
img-src 'self' data: blob: <CDN_URL origin> <CSP_EXTRA_IMG_SRC>;
font-src 'self' data: https://fonts.gstatic.com;
connect-src 'self' <API origin> <WS origin> <CSP_SENTRY_ORIGIN> <CSP_EXTRA_CONNECT_SRC>;
upgrade-insecure-requests          # лише в production-like режимі
report-uri <CSP_REPORT_URI>        # якщо задано
```

Поза production-like режимом `connect-src` додатково дозволяє `ws://localhost:*` і `ws://127.0.0.1:*` (Vite HMR).

**Режими.** Один режим діє на всі типи відповідей:

| `CSP_ENABLED` | `CSP_REPORT_ONLY` | Результат                                                                           |
| ------------- | ----------------- | ----------------------------------------------------------------------------------- |
| `false`       | будь-яке          | глобальна CSP не надсилається ніде                                                  |
| `true`        | `false`           | `Content-Security-Policy`                                                           |
| `true`        | `true`            | `Content-Security-Policy-Report-Only` для всіх відповідей, без глобальної enforcing |

Кілька політик діють незалежно ([CSP3, multiple policies](https://www.w3.org/TR/CSP3/#multiple-policies)), тому в report-only режимі жодна глобальна enforcing-політика не надсилається — інакше вона блокувала б застосунок попри режим спостереження. Без `CSP_REPORT_URI` порушення видно лише в DevTools; для централізованого збору потрібен зовнішній отримувач. `upgrade-insecure-requests` у Report-Only ігнорується.

**Власна політика маршруту.** Якщо контролер сам задає `Content-Security-Policy` або `Content-Security-Policy-Report-Only` (`responseData.setHeader`), глобальна політика для цієї відповіді не пишеться. Заголовок контролера надсилається як є, навіть при `CSP_ENABLED=false` і в report-only режимі: прапорці керують лише глобальними політиками.

**Origins.** Беруться з тих адрес, які браузер реально використовує:

- API — `CSP_API_ORIGIN`, за замовчуванням origin `APP_URL`. Має збігатися з `VITE_BASE_URL` фронтенду.
- WebSocket — origin результату `getWsUrl()` ([`get-ws-url-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/communication/get-ws-url-service.ts): `DOMAIN`, `APP_ENV`, `API_PATH_PREFIX`), саме цю адресу API віддає клієнту як `wsUrl`. Перевизначення — `CSP_WS_ORIGIN`.
- Медіа — origin `CDN_URL` (клієнт отримує його як `cdnUrl`). Це єдине джерело зображень поза `'self'`: чат підтримки та інші екрани віддають медіа тільки з нашого CDN, а не з presigned S3 URL (див. [Сховище](/backend/storage)). Запити до S3, які робить лише бекенд, у `connect-src` не потрібні.
- Sentry — `CSP_SENTRY_ORIGIN` (origin з `VITE_SENTRY_DSN`).

Невалідне значення (не origin, неправильна схема, `;`, `,` або пробіл) зупиняє старт через `validateRuntimeConfig()`.

**Чому немає `'unsafe-inline'` у `script-src`.** Vite-збірка не має inline-скриптів; єдиний inline-блок в `index.html` — `application/ld+json`, на який `script-src` не діє. `eval` / `new Function` теж заборонені: фронтенд не імпортує ArkType у runtime (перевірка JIT у ArkType викликає `new Function`), тому WS-payload перевіряються гардами з [`ws-payload-guards.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/ws-payload-guards.ts), а `ErrorCodeSchema` винесено з `shared/errors` у `shared/responses`. E2e-тест `test:e2e:csp` падає на будь-якому порушенні CSP, тож повернення ArkType у бандл буде помічене.

::: warning HTML без бекенда
Коли `SERVE_STATIC=false`, HTML віддає reverse proxy або CDN, і CSP для документа треба налаштувати там (див. [Деплой](/backend/deployment#csp-коли-фронтенд-віддає-проксі)). Бекенд у такому разі ставить лише жорстку політику на API.
:::

## Trust proxy і визначення IP

[`config/network.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/network.ts) і [`get-ip.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/network/get-ip.ts):

- `TRUST_PROXY` за замовчуванням дорівнює `false`. Тоді IP клієнта — це remote address сокета, а заголовки ігноруються.
- Якщо `TRUST_PROXY=true`, заголовкам довіряють лише тоді, коли remote address входить у `TRUSTED_PROXY_CIDRS` (підтримуються IPv4, IPv6 і IPv4-mapped адреси). Ланцюжок `X-Forwarded-For` разом із remote address обходиться справа наліво, і клієнтом вважається перша адреса, яка не належить довіреному проксі. Якщо такої немає, використовується `X-Real-IP`, а потім remote address.
- Цей IP використовують rate limit і throttling. Якщо `TRUST_PROXY` за реверс-проксі неправильно налаштовано, усі клієнти отримують спільний ліміт за IP проксі. У production-like режимі старт пише `warn`, якщо `TRUST_PROXY=false` або `TRUST_PROXY=true` з порожнім `TRUSTED_PROXY_CIDRS` ([validate-runtime-config.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/start/validate-runtime-config.ts)).

## Аудит безпеки

Початковий аудит бекенду (15 findings) закрито: стан кожного finding — виправлення, коміт або PR, тест — у [docs/security/security-analysis-status.md](https://github.com/Blazheiko/vibe-template/blob/main/docs/security/security-analysis-status.md). Кожне виправлення перевіряє регресійний тест (feat-040).

## Чекліст для production

Чекліст складено за кодом конфігурації (див. також [Конфігурація](/backend/configuration)):

- `APP_KEY`: випадковий рядок довжиною щонайменше 32 символи, наприклад `APP_KEY=<openssl rand -hex 32>`. Без нього сервер не стартує.
- `APP_ENV` не має дорівнювати `local`, бо інакше cookie втрачають `Secure`, а в тексті 500-помилок з'являються деталі.
- `APP_URL=https://...`. Залиште `SESSION_COOKIE_HOST_PREFIX` увімкненим (за замовчуванням так і є при `APP_ENV=production`/`prod` або `APP_IS_PRODUCTION=true`).
- `CSRF_ALLOWED_ORIGINS=https://app.example.com` — обов'язково, інакше сервер не стартує. `CSRF_ENFORCE` і `CSRF_STRICT_ORIGIN` залиште за замовчуванням (`true`).
- CORS: або `ENABLED_CORS=false`, або явний `CORS_ALLOWED_ORIGINS`. `CREDENTIONALS_CORS=true` вмикайте лише за потреби.
- За реверс-проксі: `TRUST_PROXY=true` і точний `TRUSTED_PROXY_CIDRS`.
- Телефонний вхід: справжній `AUTH_SMS_PROVIDER` і `AUTH_OTP_HMAC_KEY` довжиною щонайменше 32 символи. `fake` у production заборонено кодом.
- Ключі OAuth (`GOOGLE_CLIENT_SECRET=<secret>` тощо) і `*_REDIRECT_URI` на https.
- CSP: залиште `CSP_ENABLED=true`. Задайте `CSP_API_ORIGIN`, `CSP_WS_ORIGIN` (за проксі), `CSP_SENTRY_ORIGIN`, якщо адреси відрізняються від `APP_URL` / `getWsUrl()`. Перший деплой можна зробити з `CSP_REPORT_ONLY=true` і `CSP_REPORT_URI`.
- `DOC_PAGE` не вмикайте: ендпоінт `/doc/routes` реєструється лише при `APP_ENV=manual-test`.
