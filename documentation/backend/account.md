# Акаунт, профіль і сесії

Користувач, що увійшов, змінює своє ім'я, мову інтерфейсу й часовий пояс, а тема, колір і розмір шрифту зберігаються на сервері, тож вони однакові на всіх його пристроях; відкрита вкладка чи пристрій отримує зміну без перезавантаження (feat-232). Це роблять два маршрути: `GET /api/account/profile` і `PATCH /api/account/profile`. `GET /api/main/init` несе ті самі налаштування, тож застосунок застосовує їх одразу після старту.

Джерела: контракт [`contracts/account.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/account.ts), тіло [`schemas/account/update-profile.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/account/update-profile.ts) і правило імені [`profile-name.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/account/profile-name.ts), відповідь [`responses/account-controller.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/responses/account-controller.ts), правило поясу [`utils/time-zone.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/utils/time-zone.ts); у бекенді [`account-controller.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/controllers/http/user/account-controller.ts), [`account-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/account-service.ts), [`user-preferences-repository.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/repositories/user/user-preferences-repository.ts) і [`profile-transformer.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/transformers/profile-transformer.ts).

## Маршрути

| Маршрут                      | Middleware                                | Що робить                                              |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| `GET /api/account/profile`   | `session_web`, `csrf_guard`, `auth_guard` | профіль користувача, що увійшов                        |
| `PATCH /api/account/profile` | `session_web`, `csrf_guard`, `auth_guard` | змінює передані поля й відповідає профілем після зміни |

Обидва відповідають `{ "status": "success", "profile": Profile }`:

```json
{
    "status": "success",
    "profile": {
        "name": "Ann",
        "preferences": {
            "locale": "uk",
            "timeZone": "Europe/Kiev",
            "theme": null,
            "colorTheme": "mint",
            "fontSize": null
        },
        "revision": "3"
    }
}
```

Ті самі `preferences` і `revision` є в `user` відповіді `GET /api/main/init`.

## Тіло PATCH: відсутнє поле, `null` і значення

Тіло часткове: `{ name?, locale?, timeZone?, theme?, colorTheme?, fontSize? }`, щонайменше одне поле, інших ключів немає (інакше `422 validation_failed`).

- **Відсутнє поле не змінюється.**
- **`null` скидає налаштування**: вибору немає, клієнт показує значення за замовчуванням. `name` не може бути `null`.
- **Значення** — явний вибір користувача.

| Поле         | Допустимі значення                                                                                                                                                                                                                                        | Що показується за `null`               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `name`       | після `trim` і нормалізації NFC — 1–100 символів (кодових точок, як рахує `varchar(100)`), без керівних символів (`\p{Cc}`, зокрема переносів рядка) і роздільників рядка/абзацу Unicode. Розмітка — допустиме ім'я: вона екранується там, де показується | —                                      |
| `locale`     | одна з `SHIPPED_LOCALE_CODES` (`en`, `uk`, `pl`)                                                                                                                                                                                                          | мова браузера, далі `en`               |
| `timeZone`   | `UTC` або пояс IANA, відомий середовищу сервера (`isAllowedTimeZone`), до 64 символів                                                                                                                                                                     | пояс браузера                          |
| `theme`      | `light`, `dark`                                                                                                                                                                                                                                           | системна тема (`prefers-color-scheme`) |
| `colorTheme` | `COLOR_THEMES` з `shared/enums` (`ocean`, `mint`, `lavender`, `rose`, `sunset`, `monochrome`)                                                                                                                                                             | `DEFAULT_COLOR_THEME` (`rose`)         |
| `fontSize`   | ціле 14–20                                                                                                                                                                                                                                                | `DEFAULT_FONT_SIZE` (16)               |

**Часовий пояс** має одне правило для запису й читання, `isAllowedTimeZone` у `shared`: `UTC` (його немає в `Intl.supportedValuesOf('timeZone')` у Node 24, тому його додано явно), пояс із цього списку або назва, яку `Intl.DateTimeFormat` зводить до одного з них (ICU має `Europe/Kiev`, браузер може повідомити `Europe/Kyiv`). Невідомий пояс — це `400` з `reason: "unknown_time_zone"`, до витрати ліміту й без запису. Список залежить від ICU середовища: збережений пояс, якого нова версія Node вже не знає, читається як `null`, а не як помилка. Так само — збережена мова, якої інтерфейс більше не має.

## Зберігання і `revision`

Ім'я лишається в `users.name`. Налаштування — у таблиці `user_preferences`, по рядку на користувача ([База даних](/backend/database#міграціі)); рядка може не бути, тоді всі налаштування `null`.

`revision` рахує зміни профілю:

- немає рядка `user_preferences`: `"0"`;
- перший успішний `PATCH` вставляє рядок з **1**, кожен наступний додає 1 тим самим запитом (`INSERT … ON CONFLICT (user_id) DO UPDATE SET <передані поля>, revision = user_preferences.revision + 1 … RETURNING`), зокрема коли змінено лише ім'я: тоді рядок створюється або оновлюється лише заради `revision`;
- `GET /account/profile` і `init` читають ім'я й налаштування **одним запитом** (`users LEFT JOIN user_preferences`), тож ім'я й `revision` завжди з одного закоміченого стану; два читання, навіть в одній транзакції на `READ COMMITTED`, можуть побачити коміт `PATCH` між собою;
- у JSON це **десятковий рядок**, як `id`; клієнт порівнює його як число (`BigInt`), а не як рядок (`"10"` новіше за `"9"`).

Одночасні зміни різних полів зберігаються обидві (upsert пише лише передані поля); того самого поля — перемагає той, хто закомітився пізніше, і кожна додає одиницю до `revision`: їх упорядковує блокування рядка. Клієнт ігнорує знімок з меншим `revision`, ніж той, що він показує.

Ім'я й налаштування — одна транзакція (`withTransaction`), кожен виклик репозиторію в ній отримує той самий `tx`: помилка запису `user_preferences` відкочує зміну імені. Транзакція не викликає нічого поза базою.

## Відкликана сесія

Зміна записується, лише поки сесія чинна, як і зміна пароля: токен, з яким прийшов запит, має досі бути `users.session_token` (вихід на всіх пристроях або claim його змінюють), а запис сесії має існувати (вихід в іншій вкладці його видаляє). Перевірка токена — частина запису: ім'я оновлюється з `WHERE session_token = <наданий>`, а без імені рядок користувача читається `FOR SHARE` з тією самою умовою, тож відкликання, що прийшло пізніше, чекає коміту зміни. Відкликана сесія отримує ту саму відповідь, що й зміна пароля (`403 csrf_invalid`, коли запису сесії вже немає, або `401`), і нічого не записується.

## Ліміт

`accountProfileUser` ([Безпека → Спільні ліміти](/backend/security#спільні-ліміти-redis)): 30 змін на користувача у фіксованому вікні 10 хв, один бюджет для всіх його сесій, `AUTH_PROFILE_MAX_UPDATES_PER_USER_PER_10_MIN` ([Конфігурація](/backend/configuration#спільні-auth-ліміти-redis)). 31-ша зміна — `429 rate_limited`. Ліміт витрачається до запису; коли Redis не відповідає, зміна відхиляється (`503`), як в інших auth-лімітах. Сторінка акаунта зберігає налаштування одразу після зміни, тому бюджет допускає серію; повзунок шрифту надсилає лише кінцеве значення.

## На фронтенді

Сторінка акаунта має форму профілю (ім'я, мова з пунктом «Як у браузері», часовий пояс з пошуком, `UTC` і «Як у браузері») і панель налаштувань (тема: «Як у системі», світла або темна; колір і шрифт з «За замовчуванням»). Налаштування зберігаються через одну чергу на вкладку; як вона зберігає новіший вибір і що відбувається при зміні обліківки — у [Фронтенд → Налаштування](/frontend/#налаштування-мова-і-часовии-пояс).

## Жива синхронізація

Після коміту `PATCH` надсилає `broadcast:user_profile_updated` з новим `Profile` усім з'єднанням користувача на всіх інстансах, зокрема вкладці, що зробила зміну, і іншим вкладкам тієї самої сесії ([WebSocket → Події користувачу на всіх інстансах](/backend/websocket#подіі-користувачу-на-всіх-інстансах)). Відповідь його не чекає, і невдала подія не скасовує зміни. Клієнт застосовує подію як будь-який знімок, за `revision`, під своїми ненадісланими змінами, тож подія, що прийшла пізно чи двічі, нічого не псує. Події не повторюються: на `service:connection_ready` кожного підключення WS, зокрема першого, клієнт читає `GET /account/profile`. Сервер надсилає цей сигнал лише після реєстрації сокета, тож зміна, закомічена до читання, у ньому є, а закомічена після — доходить до сокета подією; браузерний `open` приходить раніше, коли сервер ще може перевіряти сесію.

## Перевірка

```bash
B=http://127.0.0.1:3000/api
O='origin: http://localhost:5173'
# після входу, як у «Як додати фічу в бекенд», з $CSRF сесії
curl -s -b cookies.txt $B/account/profile
curl -s -b cookies.txt -X PATCH -H "$O" -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -d '{"theme":"dark","fontSize":18}' $B/account/profile
curl -s -b cookies.txt -X PATCH -H "$O" -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -d '{"theme":null}' $B/account/profile
```

Тести: [`account-service.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/account-service.spec.ts), [`account-preferences.pg.test.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/account-preferences.pg.test.ts) (upsert, `CHECK`, одночасні зміни), [`account-service.pg.test.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/account-service.pg.test.ts) (відкат імені), [`account-http.pg.test.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/account-http.pg.test.ts) (маршрути через HTTP, відкликані сесії), [`account-throttle.redis.test.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/account-throttle.redis.test.ts); у фронтенді [`useProfileSave.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/composables/__tests__/useProfileSave.spec.ts) і [`e2e-live/account-profile.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/e2e-live/account-profile.spec.ts).

## Активні сесії

На сторінці акаунта користувач бачить усі свої активні входи: браузер, операційну систему, IP-адресу, як і коли увійшов, коли сесія була активна, яка з них — цей пристрій і які онлайн. Він завершує будь-яку іншу сесію або всі інші одразу, не виходячи сам (feat-233).

Джерела: контракт у [`contracts/account.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/account.ts), відповіді в [`responses/account-sessions-controller.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/responses/account-sessions-controller.ts), парсер User-Agent [`utils/user-agent.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/utils/user-agent.ts); у бекенді [`account-sessions-controller.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/controllers/http/user/account-sessions-controller.ts), [`session-list-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/session-list-service.ts) та індекс у [`session-index.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/session/session-index.ts) ([Автентифікація → Список сесій](/backend/auth#список-сесіи)).

| Маршрут                                    | Middleware                                | Що робить                                                                                          |
| ------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /api/account/sessions?cursor=<c>`     | `session_web`, `csrf_guard`, `auth_guard` | поточна сесія окремо, потім сторінка інших, від новіших до старіших                                |
| `DELETE /api/account/sessions/:id`         | `session_web`, `csrf_guard`, `auth_guard` | завершує одну іншу сесію; поточна відповідає `409` з `reason: "current_session"` (для неї є вихід) |
| `POST /api/account/sessions/revoke-others` | `session_web`, `csrf_guard`, `auth_guard` | завершує всі сесії, крім цієї, а цю перевипускає                                                   |

Повторної автентифікації немає: обидві дії лише зменшують доступ, і ними має змогу скористатися жертва, чию сесію тримає хтось інший.

### Список

```json
{
    "status": "success",
    "current": {
        "id": "Qm9vZ1hY2c3Rk5nXyZt-Aw",
        "current": true,
        "browser": "Chrome",
        "os": "macOS",
        "deviceType": "desktop",
        "userAgent": "Mozilla/5.0 (Macintosh; …) Chrome/131.0.0.0 Safari/537.36",
        "ip": "203.0.113.7",
        "method": "oauth",
        "provider": "github",
        "signedInAt": "2026-11-19T10:00:00.000Z",
        "lastSeenAt": "2026-11-19T12:00:00.000Z",
        "online": true
    },
    "others": [],
    "nextCursor": null
}
```

- `id` — **публічний id**, 22 символи base64url від `HMAC-SHA256(APP_KEY, sessionId)`. Сам id сесії (він ходить у логах, WS-токенах і `user_online`) не віддається ніколи. Публічний id обчислюється один раз, під час створення сесії, і зберігається разом з нею, тож повторно його ніхто не обчислює.
- `browser`, `os` і `deviceType` береться з User-Agent під час читання списку, парсером із `shared`, яким користується й лист про вхід (без залежностей: `ua-parser-js` v2 має AGPL). Чого він не розпізнає, те `unknown`; поруч лежить сирий `userAgent` (обрізаний до 512 символів). IP показується повністю: це власні дані користувача.
- `method`: `password` (email або телефон), `oauth` з `provider`, `register` (реєстрація за email або телефоном). Перевипущена сесія (зміна пароля, «завершити всі інші») зберігає спосіб, час входу, IP і User-Agent тієї, з якої вона походить.
- `lastSeenAt` точний до години (нижче). `online` означає, що на інстансі, який відповів, відкрито WebSocket цієї сесії (нижче).
- `current` заповнене лише на першій сторінці (без `cursor`), на наступних — `null`; серед `others` його немає ніколи. Поля `total` немає: без перевірки кожного члена воно не було б точним.

**Сторінки.** По 50 сесій, порядок `(createdAt desc, publicId desc)`. `nextCursor` — непрозора позиція (`base64url("<createdAt>:<publicId>")`) останнього **переглянутого** члена, живого чи мертвого, або `null`, коли список вичерпано. Сторінка читає щонайбільше 500 членів (константа, як і 50 та партія 64); якщо вона зупинилася на цьому, то може бути коротшою за 50, навіть порожньою, і все одно мати курсор: «Показати ще» продовжує рівно з того місця. Мертвий член (немає поля в meta, немає запису, старший за `SESSION_MAX_AGE_DAYS`) прибирається дорогою. Завершена сесія межі не зсуває, нова з'являється вище за показане, а жива лишається на своєму місці, тож нічого не пропускається і не повторюється. Курсор, якого сервер не видавав, відповідає `400`.

### Завершення однієї сесії

Так само, як вихід із цієї сесії (feat-210): її запис зникає разом із членом індексу, сокети на цьому інстансі закриваються одразу (4001), на інших — на наступній повторній перевірці (≤ `WS_SESSION_RECHECK_INTERVAL_MS`). Токен не ротується. Невідомий id, id іншого користувача і вже завершена сесія відповідають `404`, і ці випадки не розрізняються; фронтенд вважає `404` успіхом. Запис сесії, що просить, має ще існувати (вихід в іншій вкладці його видаляє), інакше `401 session_revoked`. Усі пристрої отримують push `session_revoked`.

### Завершення всіх інших сесій

Шлях зміни пароля, але без пароля:

1. запис сесії, що просить, має ще існувати, інакше `401 session_revoked`;
2. одна транзакція: `users.session_token` ротується лише тоді, коли він дорівнює пред'явленому (`updateIfSessionToken`, ADR 0002, feat-096), і разом з цим гасяться посилання скидання пароля та SMS-челенджі телефону (`retirePendingResets`, спільний із «вийти всюди» і зміною пароля). Якщо рядок не оновлено: користувача немає (`404`) або токен уже ротовано (`401 session_revoked`);
3. сокети всіх інших сесій закриваються; сокети цієї лишаються, клієнт замінить їх сам;
4. записи старого токена видаляються (лише прибирання пам'яті: ротація вже їх відкликала);
5. ця сесія перевипускається під ротованим токеном зі збереженим пристроєм.

Відповідь — частковий успіх, як у зміни пароля: `{ status: "success", sessionRenewed: true, csrfToken, wsUrl, wsToken }` або `{ status: "success", sessionRenewed: false }`, коли інші сесії завершено, але перевипуск не вдався (наприклад, упав Redis): тоді закриваються й сокети цієї сесії, і клієнт входить знову. Усі пристрої отримують push `logout_all`.

**Гонки** між двома сесіями одного користувача: виграє рівно одна ротація.

| Перший (виграв)   | Другий (програв)  | Що отримує другий                                                                                  |
| ----------------- | ----------------- | -------------------------------------------------------------------------------------------------- |
| `revoke-others`   | `revoke-others`   | його сесію відкликано: `401 session_revoked`, або `403 token_mismatch`, коли його запису вже немає |
| `revoke-others`   | `logout-all`      | те саме                                                                                            |
| `logout-all`      | `revoke-others`   | те саме                                                                                            |
| `revoke-others`   | `change-password` | те саме; пароль не змінено                                                                         |
| `change-password` | `revoke-others`   | те саме                                                                                            |
| `change-password` | `change-password` | `409` «Password was changed by another request», без змін                                          |

**Запити з однієї сесії.** Перевипуск видаляє сесію, з якої пішли інші запити сторінки, тож вони отримують `401`, який не означає, що користувач вийшов. Фронтенд (`base-api.ts`, опція `renewsSession` у `revoke-others` і `change-password`) вважає `401` застарілим, якщо CSRF-токен, з яким запит надіслано, замінив перевипуск: такий `401` доходить до викликача як `clientCode: "session_renewed"`, безпечний `GET` один раз повторюється з новою сесією, а зміна — ні («Спробуйте ще раз»). `401`, що прийшов, поки перевипуск у польоті, чекає на нього, тож порядок відповідей не має значення; якщо перевипуск не вдався, ці `401` виводять користувача як звичайно.

### Живе оновлення

Broadcast-подія `user_sessions_changed` (без даних) іде шиною подій користувача до всіх його з'єднань ([WebSocket → Події користувачу на всіх інстансах](/backend/websocket#подіі-користувачу-на-всіх-інстансах)) на вхід, вихід, перевипуск, завершення сесії, «завершити всі інші», а також коли відкривається перший сокет сесії або закривається останній. Клієнт на неї перечитує першу сторінку (події, що прийшли підряд, перечитуються один раз, 300 мс) і на кожен `service:connection_ready`, бо шина подій не повторює. Зміни `lastSeenAt` подій не надсилають.

### `lastSeenAt` і `online`

`lastSeenAt` пишеться поруч із записом, а не в нього: разом зі щогодинним оновленням cookie HTTP-запиту (невдалий запис повертає маркер оновлення, тож наступний запит спробує знову), під час відкриття WebSocket і після автентифікованого WS-повідомлення (не heartbeat) не частіше ніж раз на 15 хвилин на з'єднання, причому час зсувається лише після вдалого запису. Поки записи в Redis вдаються, він відстає від останньої дії щонайбільше на годину; сторінка показує його з точністю до години («менше години тому», «3 год тому», «вчора», дата).

`online` береться з реєстру WebSocket-з'єднань інстансу в пам'яті, а не з `user_online`. З одним контейнером застосунку (як у `docker-compose.yml`) він точний; за кількох інстансів сесія, сокет якої на іншому інстансі, показується офлайн.

::: warning План
Геолокації за IP немає (потрібна зовнішня база і її ліцензія), як і історії входів понад час життя сесії: це пункт 3 рекомендацій («Журнал важливих дій»).
:::

### Перевірка

```bash
curl -s -b cookies.txt $B/account/sessions
curl -s -b cookies.txt -X DELETE -H "$O" -H "x-csrf-token: $CSRF" $B/account/sessions/<id>
curl -s -b cookies.txt -c cookies.txt -X POST -H "$O" -H 'content-type: application/json' \
  -H "x-csrf-token: $CSRF" -d '{}' $B/account/sessions/revoke-others
```

Тести: [`session-index.redis.test.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/session/session-index.redis.test.ts) (скрипти, сторінки, рівні `createdAt`, мертві члени), [`account-sessions-http.pg.test.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/account-sessions-http.pg.test.ts) (маршрути, сокети, гонки), [`session-list-service.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/session-list-service.spec.ts); у фронтенді [`base-api-session-renewal.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/__tests__/base-api-session-renewal.spec.ts), [`ActiveSessions.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/components/account/__tests__/ActiveSessions.spec.ts) та [`e2e-live/active-sessions.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/e2e-live/active-sessions.spec.ts).
