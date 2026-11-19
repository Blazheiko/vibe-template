# Акаунт і профіль

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

Після коміту `PATCH` надсилає `broadcast:user_profile_updated` з новим `Profile` усім з'єднанням користувача на всіх інстансах, зокрема вкладці, що зробила зміну, і іншим вкладкам тієї самої сесії ([WebSocket → Події користувачу на всіх інстансах](/backend/websocket#подіі-користувачу-на-всіх-інстансах)). Відповідь його не чекає, і невдала подія не скасовує зміни. Клієнт застосовує подію як будь-який знімок, за `revision`, під своїми ненадісланими змінами, тож подія, що прийшла пізно чи двічі, нічого не псує. Події не повторюються: після кожного підключення WS, зокрема першого, клієнт читає `GET /account/profile` (інакше зміна між знімком `init` і підключенням сокета загубилася б).

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
