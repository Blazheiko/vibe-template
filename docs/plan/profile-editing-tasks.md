# Редагування профілю та синхронізація налаштувань — покроковий task list

Джерело: [`profile-editing-plan.md`](./profile-editing-plan.md) (редакція 3, рішення Р1–Р13). Базовий
шлях: `packages/`, якщо не вказано інше. Коміт для посилань: `a5d5f06`.

Фіча A — один запис у `feature_list.json`, одна гілка й PR (правила `AGENTS.md`). Задача T* — один
коміт або кілька дрібних; вона закінчується зеленим вузьким тестом свого рівня. Позначення тестів:
`shared/test/*` — `pnpm --filter shared test`; `*.spec.ts` — `pnpm --filter backend test` або
`pnpm --filter frontend test`; `*.pg.test.ts` — `make test-pg` (з `REDIS_TEST_URL`, де вказано);
`*.redis.test.ts` — `make test-redis`; `frontend/e2e/` — `pnpm --filter frontend test:e2e`
(мокований бекенд); `frontend/e2e-live/` — `pnpm --filter frontend test:e2e:live` (справжній бекенд).

**Definition of Done фічі A:** `make check`; `make test-pg` і `make test-redis` з кількістю
виконаних і пропущених тестів у доказах (або посиланнями на CI-джоби); `pnpm --filter frontend
test:e2e` і `test:e2e:live`; `pnpm docs:build && pnpm docs:verify`; ручна перевірка golden path;
усе це в `feature-state/<feat-id>/progress.md` → Evidence of Completion.

**Вибір мови до входу** (відкрите питання 1 плану) не блокує фічу A: Р7 виносить його за її межі.
Task list робить вибір мови лише в акаунті; сторінка входу — окреме майбутнє рішення.

## Порядок

T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13 → T14 → T15 → T16.

T2–T7 — backend і спільні типи, T8–T14 — frontend, T15–T16 — документація й закриття. T8 (форматер
дат) і T9 (системна тема) не залежать від API і можуть іти раніше, якщо зручно.

---

## Фіча A · Profile Editing

### T1 · Старт фічі

- [ ] PR до `main` з короткої гілки: новий запис фічі A в `feature_list.json` (`in_progress`,
      залежностей немає), опис з посиланням на план.
- [ ] Гілка фічі від `main`, `feature-state/<feat-id>/progress.md`.
- [ ] `./init.sh` зелений; результат у `progress.md`.

### T2 · Спільні переліки та межі (`shared/src/enums`) — Р2, Р3

- [ ] `enums/preferences.ts`: `THEMES = ['light', 'dark']`, `COLOR_THEMES` (перенести перелік з
      `frontend/src/views/UserAccount.vue`, `colorThemes`), `DEFAULT_COLOR_THEME = 'rose'`,
      `FONT_SIZE_MIN = 14`, `FONT_SIZE_MAX = 20`, `DEFAULT_FONT_SIZE = 16`; експорт з
      `enums/index.ts`.
- [ ] `UserAccount.vue` і `stores/state.ts` беруть ці значення з `shared/enums` (поведінка не
      змінюється).
- [ ] Тест (`shared/test/`): `DEFAULT_COLOR_THEME ∈ COLOR_THEMES`, межі шрифту.
- [ ] `pnpm --filter frontend test` без регресій.

### T3 · Схема запиту й відповіді, контракт (`shared`) — Р2–Р4, Р6, Р12

- [ ] `schemas/account/profile-name.ts`: нормалізація імені (`trim`, NFC), 1–100 символів, без
      керівних символів (`\p{Cc}`) і переносів рядка. Реєстраційні схеми імені (`register-email.ts`,
      `register-phone-complete.ts`) не змінюються в цій фічі.
- [ ] `shared/src/utils/time-zone.ts`: **одне правило допустимого поясу** для запису й читання —
      `allowedTimeZones()` = `['UTC', ...Intl.supportedValuesOf('timeZone')]` (у Node 24 список
      не містить ні `UTC`, ні `Etc/UTC`) і `isAllowedTimeZone(value)`; експорт з `utils/index.ts`
      (поруч з `phone.ts`). Ним користуються сервіс
      (T6, запис і читання) і селектор сторінки акаунта (T13).
- [ ] `schemas/account/update-profile.ts`: часткове тіло `{ name?, locale?, timeZone?, theme?,
colorTheme?, fontSize? }`; `name` не приймає `null`; поля налаштувань приймають `null`
      (скидання, Р2); порожнє тіло — помилка; невідомі ключі — помилка. `timeZone` тут — лише рядок
      ≤ 64; належність до IANA перевіряє сервер (T6).
- [ ] `responses/account-controller.ts`: `ProfileSchema = { name, preferences: { locale, timeZone,
theme, colorTheme, fontSize }, revision }`; усі поля `preferences` — значення або `null`;
      `revision` — десятковий рядок (`/^\d+$/`, Р12).
- [ ] `contracts/account.ts`: `getProfile` (`get /account/profile`), `updateProfile`
      (`patch /account/profile`); реєстрація в `contracts/index.ts`.
- [ ] `responses/main-controller.ts`: `InitResponse.user.preferences`, `InitResponse.user.revision`
      (Р6).
- [ ] Тести (`shared/test/`): ім'я — порожнє після `trim`, 100/101 символ, `\n`, `\u0007`, NFC
      (`é` складене й розкладене дають однаковий результат); тіло — `null` проти відсутнього поля,
      `name: null`, порожнє тіло, невідомий ключ, мова поза `SHIPPED_LOCALE_CODES`, шрифт 13/21,
      колір поза переліком; відповідь — `revision` `"0"`, `"42"`, відмова для `42` (число) і `"-1"`;
      `isAllowedTimeZone`: `'UTC'` і `'Europe/Kyiv'` — так, `'Mars/Base'` і `''` — ні.

### T4 · Таблиця `user_preferences` і міграція — Р1, Р12

- [ ] `backend/src/database/schema.ts`: `userPreferences` — `user_id bigint` PK з `REFERENCES
users(id) ON DELETE CASCADE`; `locale varchar(8)`, `time_zone varchar(64)`, `theme`,
      `color_theme`, `font_size smallint` — усі nullable; `revision bigint NOT NULL` без
      `DEFAULT`; `updated_at timestamp NOT NULL DEFAULT now()`. `CHECK`: `theme IN (…)`,
      `color_theme IN (…)` з `shared/enums`, `font_size BETWEEN 14 AND 20`, `revision >= 1`.
- [ ] `database/relations.ts`: `users` ↔ `userPreferences` (one-to-one).
- [ ] `pnpm --filter backend db:generate --name user_preferences` (формат 1.0, папка на
      міграцію); міграція створює порожню таблицю, нічого не переносить.
- [ ] `account-preferences.pg.test.ts`: міграція на чистій БД; `CHECK` відхиляє `font_size = 21`,
      невідомий колір, `revision = 0`; видалення користувача видаляє рядок.

### T5 · Репозиторії — Р1, Р2, Р12

- [ ] `app/repositories/user/user-preferences-repository.ts`:
    - `findByUserId(userId, executor = db)`;
    - `applyPatch(userId, patch, tx)`: `INSERT … (revision = 1, лише передані поля) ON CONFLICT
(user_id) DO UPDATE SET <лише передані поля>, revision = user_preferences.revision + 1,
updated_at = now() RETURNING *`; `null` у `patch` записується як `NULL`; відсутнє поле не
      входить ні в `INSERT`, ні в `SET`; порожній `patch` (зміна лише імені) лише збільшує
      `revision`.
- [ ] `userRepository.updateName(userId, name, tx)`.
- [ ] Експорт через `app/repositories/index.ts`.
- [ ] `account-preferences.pg.test.ts` (продовження):
    - немає рядка → `findByUserId` повертає `undefined`;
    - перший `applyPatch` → `revision` 1, наступні → 2, 3; порожній `patch` → +1;
    - частковий `patch` не затирає інших полів; `null` скидає лише своє поле;
    - два одночасні `applyPatch` різних полів (`race-barrier.ts`) — обидва поля збережені,
      `revision` +2;
    - два одночасні `applyPatch` того самого поля — збережене значення того, хто закомітився
      пізніше, `revision` +2.

### T6 · Сервіс і ліміт — Р3, Р5, Р12

- [ ] `config/throttle-policies.ts`: `accountProfileUser` — `fixedWindow('account_profile_user',
'user', 30, 10 хв)` (значення в `config/auth.ts` як інші ліміти, `AUTH_PROFILE_MAX_UPDATES_PER_USER_PER_10_MIN`
      — або константа, якщо власник не хоче змінної; рішення записати в `progress.md`).
- [ ] `app/services/user/account-service.ts`:
    - `getProfile(userId)`: ім'я з `users`, налаштування з `user_preferences` або всі `null`,
      `revision` з рядка або `"0"`; збережений `time_zone`, для якого `isAllowedTimeZone` хибне
      (зник з ICU нової версії Node), віддається як `null` (Р3);
    - `updateProfile(userId, body)`: пояс перевіряється тим самим `isAllowedTimeZone` до
      транзакції; ліміт (`enforceThrottle`) до транзакції; `withTransaction`, у якому
      `updateName` (якщо є `name`) і `applyPatch` отримують **той самий `tx`**; повертає `Profile`.
- [ ] Транзакція не викликає зовнішніх сервісів і не тримає блокування рядка `users` довше за
      запис.
- [ ] `account-service.spec.ts` (юніт, репозиторії замоковані): неіснуючий пояс → `badRequest`
      без запису; ліміт вичерпано → `rateLimited` без запису; зміна лише імені викликає
      `applyPatch` з порожнім `patch`; `revision` з відповіді — рядок.
- [ ] `account-service.pg.test.ts`: **помилка `applyPatch` (наприклад, `CHECK` на рівні БД через
      обхід схеми) відкочує зміну імені**; пояс, що зник з ICU, читається як `null`;
      `PATCH { timeZone: 'UTC' }` зберігає і читає `'UTC'`, а не `null`.
- [ ] **Ім'я з розміткою через новий API** (ризик плану): `account-service.pg.test.ts` зберігає
      `<img src=x onerror=alert(1)>` як ім'я без змін (це валідне ім'я); тест шаблонів листів
      (поруч з `auth-email-templates.snapshot.spec.ts`) для листа після зміни імені показує його
      екранованим.
- [ ] `account-throttle.redis.test.ts`: 30 змін проходять, 31-ша → `rateLimited`; дві різні сесії
      одного користувача ділять один бюджет; недоступний Redis — та сама поведінка, що в наявних
      auth-лімітах (перевірити й записати).

### T7 · Контролер, маршрути, `init` — Р4, Р6

- [ ] `app/transformers/profile-transformer.ts` (+ spec): рядок → `Profile`.
- [ ] `app/controllers/http/user/account-controller.ts`: `getProfile`, `updateProfile` через
      наявні controller-хелпери.
- [ ] `app/routes/contract-schemas/account.ts` + `index.ts`; `http-routes.ts`: група `account`
      (`session_web`, `csrf_guard`, `auth_guard`).
- [ ] `main/init` (`InitResponse.user`): `preferences` і `revision` з `accountService.getProfile`;
      анонімна відповідь без змін.
- [ ] Тести: `route-contracts.spec.ts` і `route-access.spec.ts` охоплюють нові маршрути;
      `layering.spec.ts` проходить; `account-http.pg.test.ts` (з `REDIS_TEST_URL`): анонімний →
      401; без CSRF → 403; запит з відкликаною сесією (вихід в іншій вкладці, `logoutAll`) —
      та сама відповідь, що в наявних захищених оновленнях (зміна пароля), без запису; `PATCH`
      повертає новий `revision`, наступний `init` — те саме.
- [ ] `account-http.pg.test.ts`, **повний шлях початкового профілю**:
    - новий користувач без рядка `user_preferences`: `GET /account/profile` і `init` — усі поля
      `preferences` `null`, `revision: "0"`;
    - перший `PATCH` лише імені → нове ім'я, `revision: "1"`;
    - наступні `GET` і `init` віддають те саме ім'я й `revision: "1"`;
    - `PATCH { timeZone: 'UTC' }` → `GET` і `init` віддають `'UTC'`, `revision: "2"`.
- [ ] `make check` зелений.

### T8 · Форматер дат (`frontend`) — Р8

- [ ] `composables/useDateFormat.ts`: `formatDateTime`, `formatDate`, `formatRelative`; пояс —
      `timeZone` профілю або браузера; мова — поточна мова інтерфейсу.
- [ ] Перехід чотирьох місць: `views/UserAccount.vue`, `views/admin/AdminUsersView.vue`,
      `views/admin/AdminHistoryOnlineView.vue`, `components/admin/AdminUserDetailModal.vue`.
      `stores/push.ts` **не змінюється** (метадані підписки пристрою).
- [ ] `useDateFormat.spec.ts`: та сама мить у `Europe/Kyiv` і `America/New_York`; перехід через
      північ (дата відрізняється між поясами); перехід на літній і на зимовий час; `null` → пояс
      браузера.

### T9 · Системна тема лише за `theme = null` — Р13

- [ ] `App.vue`: слухач `prefers-color-scheme` викликає зміну теми лише коли тема не вибрана
      явно; закоментований код прибрати.
- [ ] Тест (юніт або компонентний): за `theme = 'light'` зміна системної теми нічого не змінює;
      за `null` — змінює.

### T10 · Стан профілю й кеш (`stores/user.ts`, `stores/state.ts`) — Р2, Р6, Р10, Р12

- [ ] `stores/user.ts`: `profile` (`name`, `preferences`, `revision`) з `init`; `applyProfile(snapshot)`
      застосовує знімок, лише якщо `BigInt(snapshot.revision) >= BigInt(current.revision)`.
- [ ] `stores/state.ts`: ефективні значення = явний вибір профілю або значення за `null` (Р2:
      системна тема, `DEFAULT_COLOR_THEME`, `DEFAULT_FONT_SIZE`); серверний `null` замінює
      кешоване значення.
- [ ] Кеш `localStorage` `prefs:<userId>` (перший кадр без спалаху); ключі пристрою (`theme`,
      `colorTheme`, `fontSize`) — для анонімного стану.
- [ ] Вихід / вхід іншим користувачем (Р10): застосувати налаштування пристрою, потім нового
      користувача; кеш попереднього не застосовується.
- [ ] `stores/__tests__/`: знімок з меншим `revision` ігнорується; `"10"` > `"9"`; серверний
      `null` замінює кеш; вихід і вхід іншим користувачем не переносить теми попереднього; перший
      кадр бере `prefs:<userId>`.

### T11 · Черга автозбереження (`composables/useProfileSave.ts`) — Р10, Р11

- [ ] Два шари: підтверджений знімок і ненадіслані зміни; інтерфейс = підтверджений + ненадіслані.
- [ ] Один запит у дорозі; нові зміни об'єднуються (останнє значення поля) і йдуть наступним
      `PATCH` лише зі зміненими полями; затримка 500–800 мс для повзунка шрифту.
- [ ] Успіх: оновлює підтверджений шар (через `applyProfile`), знімає з ненадісланих лише поля зі
      значенням, яке було відправлено.
- [ ] Невдача: знімає лише поля цього запиту, не змінені після відправлення; повідомлення про
      помилку; `rateLimited` показується як окреме повідомлення.
- [ ] Черга прив'язана до `userId`; вихід, вхід іншим користувачем або 401 — скасувати таймер,
      відкинути ненадіслане, ігнорувати відповіді запитів у дорозі; `PATCH` з іншим поточним
      `userId` не надсилається.
- [ ] `useProfileSave.spec.ts` (API замоковано, керований порядок відповідей):
    - об'єднання змін, поки запит у дорозі; надсилаються лише змінені поля;
    - **відповіді у зворотному порядку**: невдача старого запиту не відкочує новішого значення;
    - **успіх зі старим значенням**: відправили `dark`, вибрали `light`, прийшов успіх із `dark`
      — лишається `light`, і `light` іде наступним `PATCH`;
    - **зміна обліківки** під час затримки і під час запиту в дорозі: таймер скасовано,
      ненадіслане відкинуто, відповідь попередньої обліківки проігноровано, жодного `PATCH` з
      іншим `userId`;
    - 401 зупиняє чергу.

### T12 · Мова з профілю (`useLocale.ts`) — Р7

- [ ] Пріоритет: мова профілю → мова браузера → `en`; зміна мови в профілі перемикає інтерфейс
      без перезавантаження (`loadLocale`); `null` повертає мову браузера.
- [ ] `supportLanguage()` не змінюється.
- [ ] Тести (`composables/__tests__/`): профіль `uk` при браузері `pl` → `uk`; `null` → `pl`;
      мова, файл якої не завантажився → `en` (наявна поведінка `loadLocale`).

### T13 · Сторінка акаунта (`views/UserAccount.vue`) — Р2, Р4, Р11

- [ ] Панель профілю — форма: ім'я (з помилками валідації сервера), мова (з пунктом «Як у
      браузері»), часовий пояс (список `allowedTimeZones()` з пошуком, з явним пунктом `UTC` і
      пунктом «Як у браузері»).
- [ ] Панель налаштувань: темна тема (три стани: «Як у системі» / світла / темна), колір і шрифт
      з «За замовчуванням»; збереження через `useProfileSave`.
- [ ] Ім'я в заголовку й аватар-заглушка оновлюються після збереження.
- [ ] Переклади `locales/en.ts`, `uk.ts`, `pl.ts` (підписи, помилки, «Як у браузері/системі»,
      «За замовчуванням»).
- [ ] `views/__tests__/`: форма надсилає лише змінені поля; помилка сервера для імені показується
      біля поля; «Як у системі» надсилає `theme: null`.
- [ ] `frontend/e2e/` (мокований бекенд): зміна імені та мови на сторінці акаунта; помилка
      валідації імені.

### T14 · Сценарії на справжньому бекенді (`frontend/e2e-live/`)

- [ ] Зміна імені, мови, поясу й теми переживає перезавантаження.
- [ ] Другий контекст браузера тієї самої обліківки після входу отримує ту саму тему, мову й пояс.
- [ ] «Як у системі» для теми: після перезавантаження діє системна тема (емуляція
      `colorScheme` у Playwright).
- [ ] Вихід і вхід іншим користувачем у тому самому контексті — без оформлення попереднього.
- [ ] Ім'я з розміткою (`<img src=x onerror=alert(1)>`), збережене через сторінку акаунта,
      показується як текст у заголовку акаунта й у списку та картці користувача в адмінці; жодного
      діалогу чи нового елемента `img` (перевірка через `page.on('dialog')` і DOM).

### T15 · Документація

- [ ] Нова сторінка `documentation/backend/account.md` і `documentation/en/backend/account.md`:
      маршрути, тіло й відповідь, семантика відсутнього поля / `null` / значень за замовчуванням,
      `revision`, ліміт, джерела на GitHub.
- [ ] Сайдбар обох локалей (`documentation/.vitepress/config.ts`), `KEY_PAGES` і `EN_KEY_PAGES`
      (`documentation/scripts/verify-dist.mjs`).
- [ ] `backend/database.md` (таблиця `user_preferences`, міграція), `backend/configuration.md`
      (змінна ліміту, якщо вона є), `reference/roles-capabilities.md` («Account / profile update»
      → так), фронтенд-сторінка про налаштування, мову, пояс і кеш — обидві локалі.
- [ ] Позначити в `docs/plan/future/template-functionality-recommendations.md`, що пункт 1
      реалізовано фічею A.
- [ ] `pnpm docs:build && pnpm docs:verify`.

### T16 · Перевірка і закриття

- [ ] `make check`; `make test-pg` і `make test-redis` з `PG_TEST_URL` і `REDIS_TEST_URL` (кількість
      виконаних і пропущених); `pnpm --filter frontend test:e2e` і `test:e2e:live`.
- [ ] Мутації ключових гарантій (кожна має завалити свій тест; записати в `progress.md`):
      **атомарність** — ім'я й налаштування в різних `tx`; **приріст версії** — `revision` без
      `+1` при `UPDATE`; **збереження новішого вводу** — успіх або невдача знімає всі ненадіслані
      поля; **ізоляція обліківок** — черга не перевіряє `userId`.
- [ ] Ручна перевірка golden path: два браузери, одна обліківка — зміна імені, мови, поясу й теми в
      одному, перезавантаження іншого; скидання теми в «Як у системі»; вихід і вхід іншим
      користувачем.
- [ ] Evidence of Completion у `progress.md`; PR реалізації; статус `review` окремим PR; незалежне
      рев'ю; merge; «Mark done».

---

## Фіча B · Live Profile Sync (відкладено)

Окремий запис у `feature_list.json` після A. Передумова для кількох інстансів бекенду —
міжпроцесна розсилка подій користувачу (Redis pub/sub), окреме рішення.

- [ ] Подія WS `user.profile_updated` з `Profile`: після успішного `PATCH` усім з'єднанням
      користувача, включно з ініціатором і іншими вкладками тієї самої сесії (не
      `exceptSessionId`); схема в реєстрі broadcast-подій.
- [ ] Фронтенд застосовує подію через `applyProfile` (ідемпотентно за `revision`) з тими самими
      правилами шарів, що й `useProfileSave`.
- [ ] Після reconnect WS — `GET /account/profile` і `applyProfile`.
- [ ] Тести: дві вкладки однієї сесії й одна іншої — зміна теми в одній видна в обох без
      перезавантаження; подія з меншим `revision` ігнорується; reconnect перечитує профіль.
- [ ] `backend/websocket.md` (обидві локалі).
