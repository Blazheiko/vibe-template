# Code review fixes — покроковий task list (v4)

Джерело: `docs/security/code-review-main-2026-10-31.md`.
Базовий шлях для посилань: `packages/backend/src/`, якщо не вказано інше. Коміт для рядків: `a82b65a`.

**v4 — що змінено після третього рев'ю:**

- B: кеш `userToken` на 60 s суперечив критерію «після відновлення Redis одразу 401» (застарілий кеш після збою інвалідації; гонка «паралельне читання БД записує старе значення після інвалідації»). Рішення для ADR: **перша реалізація — звірка з БД без кешу**; кешування — окремий наступний крок з явно визначеною допустимою затримкою відкликання і тестами обох сценаріїв.
- B: `userToken` і `sessionGeneration` еквівалентні лише за однакової перевірки актуальності — варіант (2) прибрано, починаємо з наявного `userToken`.
- B: `logoutAll` (`session-handler.ts:404-425`) лише видаляє Redis-ключі і **не ротує** `users.sessionToken` — додано явну ротацію в БД зі збереженням зовнішнього API.
- B2: залежність від B записана явно — очищення сесій після commit спирається на гарантію B; B2 не випускати окремо.
- D0: використовувати наявну подію `support_chat_error` (`support-service.ts:158,219`, `shared/src/schemas/ws/broadcast-events.ts:13`, `frontend/src/composables/useBroadcastHandler.ts:35`), а не нову `support:error`.
- D2: `promptChars / 2` — евристика, не верхня межа; формулювання виправлено.
- D1: додано тест «lock отримано → резерв бюджету відхилено → lock звільнено».

**v3 — що змінено після другого рев'ю:**

- B: підтверджено, що `session-handler.ts` / `ws-session-auth.ts` **не звіряють** `users.sessionToken` — сесії читаються лише з Redis. Ротація токена в БД сама по собі нічого не відкликає; потрібен механізм перевірки відкликання, незалежний від успішного SCAN/DEL. Конкурентний тест — два запити з однаковим правильним старим паролем і різними новими; потрібен умовний UPDATE / row lock.
- C: втрачена pub/sub-подія залишає пасивного підписника з broadcast-доступом; додано періодичну повторну перевірку активних admin-підписок, визначений максимальний час відкликання і тест із пропущеною подією. Критерій переформульовано під реальну гарантію.
- D: inflight-lock з токеном власника і умовним видаленням; резерв бюджету повертається лише до відправлення провайдеру; перевірка + резервування — одна атомарна операція; бюджет явно «приблизний» або консервативна верхня межа. WS-контролер `support-controller.ts:36-44` робить `void supportService.chat()` і одразу відповідає `ok` — перевірка допуску винесена **до** підтвердження, описана WS-подія відмови.
- G1 → окрема рання фаза **B2** (security-фікс гонки одноразових токенів у транзакції з fault-injection), а не частина тестового покриття.
- F розділено на F1–F4 (retention, auth-контракт, DB config, frontend) — незалежні PR.
- G3 розділено за доказами: UI-стани на mocks, відкликання сесій між browser-context — проти реального backend.

**v2 — що змінено після першого рев'ю плану:**

- PR розбиті на вужчі: кожна зміна з міграцією, зміною контракту або з незалежним відкатом — окремий feature.
- Критерії приймання переписані як перевірювана поведінка; скорочення рядків — лише статистика в `progress.md`, не критерій.
- Зміни поведінки (env `yes/on`, locale-стаби, обрізання історії, retention промптів) винесені з рефакторингів у окремі рішення з явним контрактом.
- Додана фаза регресійного покриття **до** рефакторингів — існуючі e2e (`frontend/e2e/vue.spec.ts`, `mobile-layout.spec.ts`) перевіряють лише завантаження сторінки і мобільну верстку, auth-flow не покриті.
- Виправлені фактичні помилки v1: `destroyAllSessions(token, keepSessionId)` **не зберігає** поточну сесію (видаляє її наприкінці в `MULTI`, `redis-session-storage.ts:291-295`); `updateByEndpoint` без `userId` — навмисний сценарій перенесення підписки (`push-subscription-service.ts:53-62`); `Object.values(...) as const` — некоректно.

Кожна фаза = окремий рядок у `feature_list.json` + гілка + PR (правила `AGENTS.md`). Definition of Done спільний: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` (+ `test:redis` / `test:pg` де зачеплено), `pnpm docs:build && pnpm docs:verify` при зміні документації, evidence в `progress.md` на гілці. Оцінки часу — орієнтовні, без урахування рев'ю.

Пріоритети: 🔴 зараз · 🟠 далі · 🟡 регресійна сітка · 🟢 рефакторинг/чистка (вузькі PR, паралельно) · 🔵 гігієна.

---

## Відповідність фаз і `feature_list.json`

Заголовки фаз і зведена таблиця нижче використовують ті самі `feat-NNN`, що й `feature_list.json`; літерні id (`feat-059b`, `feat-063a`…) з ранніх версій плану замінені цією таблицею.

| Фаза | feat     | Фаза | feat     | Фаза | feat     |
| ---- | -------- | ---- | -------- | ---- | -------- |
| A    | feat-058 | F3   | feat-067 | K1   | feat-077 |
| B    | feat-059 | F4   | feat-068 | K2   | feat-078 |
| B2   | feat-060 | G    | feat-069 | K3   | feat-079 |
| B3   | feat-061 | H1   | feat-070 | L    | feat-080 |
| C    | feat-062 | H2   | feat-071 | M    | feat-081 |
| D    | feat-063 | H3   | feat-072 | N    | feat-082 |
| E    | feat-064 | H4   | feat-073 | O    | feat-083 |
| F1   | feat-065 | H5   | feat-074 | I    | feat-075 |
| F2   | feat-066 | J    | feat-076 |      |          |

Рішення архітектури для B — [`docs/adr/0002-session-revocation-via-user-token.md`](../adr/0002-session-revocation-via-user-token.md) (прийнято).

## Рекомендований порядок

```
A (IDOR) → B (sessions, звірка з БД) → B2 (one-time token race, залежить від B) → C (WS admin revoke) → D (resource limits) → E (OAuth)
   B3 (кеш userToken) — опційно після B, за бенчмарком
   → F1 (prompt retention) · F2 (auth contract) · F3 (DB config) · F4 (frontend) — незалежні
   → G (regression coverage) → H1…H5 (auth refactor, по кроку) → I (fe/shared dedup) → J (fe split)
паралельно, вузькими PR:  K1 dead code backend · K2 dead code shared · K3 dead code frontend · L hygiene · M schema · N env-parsers (контракт) · O locales (контракт)
```

---

## A · ✅ feat-058 · IDOR у push-підписках

**Гілка:** `fix/push-subscription-idor` · **Залежності:** немає · **Оцінка:** 0.5 д

### Зміни

- [x] `app/repositories/notifications/push-subscription-repository.ts:141-147` `update()` — `.returning()`, повертати `rows.at(0)`; прибрати `findById(id)`. _Виконано #188: рядок береться з самого `UPDATE … WHERE id AND user_id … RETURNING`, окремого `findById` немає._
- [x] `:166-172` `deactivate()` — те саме. _#188._
- [x] `updateByEndpoint` (`:149-155`) — **не чіпати** `WHERE`: перенесення підписки між акаунтами після перевірки `p256dh`/`auth` ключів — навмисне (`push-subscription-service.ts:53-62`). Додати коментар у репозиторії, чому там немає `userId`. _#188: `WHERE` не чіпали, коментар у репозиторії є._
- [x] `app/services/notifications/push-subscription-service.ts:190-197, 271-286` — без змін логіки (`undefined → notFound`), перевірити, що немає інших місць, де результат `update`/`deactivate` вважається «свій». _Перевірено в #188/#190: `undefined → notFound`, інших місць, де результат вважається «своїм», немає._

### Критерії приймання

- [x] Чужий id і неіснуючий id → однаковий 404 з однаковим тілом (без різниці у timing-чутливому тексті). _`push-subscription-ownership.pg.test.ts`: «answers a foreign id like a missing one and leaks nothing» (`foreign.body` дорівнює `missing.body`)._
- [x] Відповідь на чужий id не містить жодних полів чужого запису. _Той самий тест (`expectNoLeak`), а також для порожнього тіла, `GET /:id`, `/statistics`, `DELETE /:id`._
- [x] Чужий запис після запиту незмінний (`updatedAt`, `lastUsedAt`, `isActive` — як були). _Той самий тест порівнює рядок до і після (`rowOf`)._
- [x] Свій id → 200, оновлені поля. _«updates the caller own subscription», «deactivates the caller own subscription»._
- [x] Перенесення підписки по `endpoint` з тими самими ключами на інший акаунт — працює як раніше (регресія на `updateByEndpoint`). _«moves the subscription to the caller when the browser keys match»; з іншими ключами — 409 і власник лишається (`answers 409 and keeps the owner when the keys differ`)._

### Тести

- [x] Integration (`test:pg`, реальний PostgreSQL, через HTTP-роут із `auth_guard`, два юзери): всі критерії вище. Не лише мок репозиторію. _#188, переписано на справжній HTTP (uWS, реальна таблиця маршрутів, валідація тіла, `auth_guard`; `session_web` і `csrf_guard` замінені) у #190: 14 тестів, 3 з них падали на старому репозиторії з 200 замість 404._
- [x] Unit у `push-subscription-repository.spec.ts`: `update` на 0 рядків → `undefined`. _Додано в PR «Відмітити виконане в плані»: 5 тестів на мокнутому `db` (0 рядків → `undefined`, `db` не має `select`, тож перечитування за `id` кидає); на старому коді 3 з 5 падають._

---

## B · ✅ feat-059 · Відкликання сесій при зміні пароля

**Гілка:** `fix/change-password-revoke-sessions` · **Залежності:** немає · **Оцінка:** 1 д

### Факти з коду

- `auth-service.ts:1268-1353` `changePassword` оновлює лише `password`; `renewSession` (`:1210-1243`) робить `auth.login(userId, userToken)` зі **старим** `userToken` → інші Redis-сесії `session:<userToken>:*` живі.
- `destroyAllSessions(userToken, keepSessionId)` (`redis-session-storage.ts`) пропускає `keepSessionId` під час SCAN, але видаляє його в кінці разом із cursor-ключем. Це для того, щоб поточний запит дожив до відповіді, а не щоб зберегти сесію.
- **`session-handler.ts`, `ws-session-auth.ts`, middlewares не містять жодної згадки `sessionToken`** — сесія читається з Redis і вважається валідною, якщо ключ існує. Ротація `users.sessionToken` у БД сама по собі **нічого не відкликає**: якщо SCAN/DEL не завершився (Redis впав, deadline), старі ключі залишаться валідними після відновлення Redis. Це підтверджена прогалина, а не відкрите питання.
- `password-reset-service.ts:616-639` робить `sessionToken: nanoid()` + `destroyAllSessions(previous)` — референс, але з тією самою прогалиною.

### Рішення (ADR у `docs/adr/`): звірка `userToken` з БД, без кешу в першій реалізації

- **Механізм:** `auth_guard` (HTTP) і `ws-session-auth` (кожне WS-повідомлення) порівнюють `session.data.userToken` з `users.sessionToken`, прочитаним **безпосередньо з БД** (`SELECT session_token FROM users WHERE id = ?`). Невідповідність → знищити сесію, 401. Використовуємо наявний `userToken`; нове поле (`sessionGeneration`) гарантій не додає — воно має ту саму проблему актуальності.
- **Чому без кешу:** кеш з TTL суперечить критерію «після відновлення Redis одразу 401» — (а) якщо Redis недоступний під час інвалідації, після відновлення він може містити старий токен; (б) гонка: паралельне читання БД → інвалідація → запис старого значення в кеш. Звірка з БД робить security-гарантію доказовою однією точкою.
- **Вартість:** +1 indexed primary-key read на автентифікований запит. Для шаблону прийнятно; виміряти в `progress.md` (p50/p95 на auth_guard до/після).
- **Кешування — окремий наступний крок (feat-061, після B):** лише з явно визначеною допустимою затримкою відкликання `SESSION_REVOCATION_MAX_DELAY` (напр. 30 s), з інвалідацією через `DEL` + захистом від гонки (версія/`SET` лише якщо значення не старіше — або read-through з коротким TTL без явної інвалідації), і з тестами **обох** сценаріїв: збій Redis під час ротації і гонка read/invalidate. Критерій B тоді змінюється на «не пізніше ніж через `SESSION_REVOCATION_MAX_DELAY`».
- `destroyAllSessions` залишається як best-effort очищення пам'яті Redis, не як гарантія безпеки.

### Зміни (явний перехід станів)

- [x] Звірка `userToken` з БД у `sessionHandler` (`session_web`, `session_api` — а отже перед `auth_guard`), `wsSessionHandler` (кожне WS-повідомлення) і `verifyUpgradeToken` (WS upgrade). Один helper `assertSessionTokenCurrent(sessionInfo, userToken): Promise<'ok' | 'mismatch' | 'unavailable'>` у `vendor/utils/session/`, перевірка реєструється застосунком (`registerSessionTokenChecker`); анонімні сесії пропускаються. **Fail-closed:** `mismatch` → запит анонімний (401 на `auth_guard`), запис видаляється best-effort; `unavailable` (помилка або **дедлайн** `SESSION_TOKEN_CHECK_TIMEOUT_MS`, за замовчуванням 2000 мс) → `503` (`SessionVerificationUnavailableError`), запит **не** пропускається за самим Redis-записом. Для WS: повідомлення не обробляється (клієнт отримує 503-конверт, з'єднання лишається — як при недоступному Redis), upgrade → `503`. _(Спершу планувалося закривати WS-з'єднання; ADR 0002 «Уточнення при реалізації» зафіксував реалізовану поведінку.)_
- [x] `changePassword`:
    1. Перевірити поточний пароль.
    2. **Умовний** UPDATE: `UPDATE users SET password = :new, session_token = :newTok WHERE id = :id AND password = :currentHash` (hash, який щойно пройшов перевірку) `.returning()`; 0 рядків → 409 «Password was changed concurrently» (або 400). Альтернатива — `SELECT … FOR UPDATE` у транзакції, якщо порівняння по hash незручне.
    3. `destroyAllSessions(previousSessionToken, currentSessionId)` — best-effort; помилка логується, **не** змінює код відповіді, бо звірка з БД уже гарантує відкликання.
    4. Повернути `{ newSessionToken }` контролеру.
- [x] `auth-controller.ts` — `authService.renewSession(auth, session, rotatedUserToken)` → `auth.login(userId, newSessionToken)` → нова сесія, CSRF, wsToken (параметризувати ту частину `renewSession`, що генерує CSRF/ws).
- [x] Відмова Redis при очищенні (після кроку 2): пароль не відкочується, `change-password` лишається `200`, а очищення логується; сесії відкликає звірка з БД, а не `DEL`. Якщо падає видача нової сесії поточному клієнту (`renewSession`, Redis), відповідь — `200` з `sessionRenewed: false` (клієнт входить знову), а не `503`. _(Спершу планувалося `503`; обрано `sessionRenewed: false`, бо пароль уже змінено.)_
- [x] Те саме в `password-reset-service.ts` (email і phone): `destroyAllSessions` best-effort, збій не зупиняє скидання і позначення токена використаним.
- [x] **`logoutAll` — ротація в БД.** Обрано варіант «ротація в `authService.logoutAll` **до** виклику `auth.logoutAll()`» (vendor-шар не має доступу до репозиторіїв; інжекція `rotateUserToken` ускладнила б ядро заради одного виклику). Зовнішній контракт `auth.logoutAll(): Promise<number>` і відповідь не змінені. Збій ротації → помилка без звернення до Redis.
- [x] `documentation/backend/auth.md` — опис механізму відкликання, поведінки при відмові Redis/БД, і що `destroyAllSessions` — очищення, не гарантія.

### Додатково (рев'ю feat-059)

- [x] Дедлайн перевірки: `SESSION_TOKEN_CHECK_TIMEOUT_MS` (за замовчуванням 2000 мс, ціле 1…60000, інакше помилка на старті); запит, що завис, дає `503`, а не очікування. Запит **скасовується**, а не покидається, і без дедлайну в коді застосунку: читання йде через окремий пул із 5 зʼєднань (константа) зі `statement_timeout` = дедлайн (сервер скасовує, `57014`) і `query_timeout = timeout + 500 мс` (сервер, що не відповідає: зʼєднання знищується, слот звільняється). Перевірено на реальному PostgreSQL блокуванням таблиці `users` та проксі, що перестає пересилати.
- [x] HTTP-контракт доведено на реальному сервері (`session-revocation-http.pg.test.ts`, реальні `session_web`/`csrf_guard`/`auth_guard`, PostgreSQL, Redis): статуси, `Set-Cookie`, CSRF, відповідь контролера, конкурентні запити, reset-flow з невдалим очищенням, `503` і дедлайн.

### Критерії приймання

- [x] Стара cookie сесії A → 401; сесія B → 401; нова cookie з відповіді A → 200; `csrfToken`/`wsToken` нові; старий CSRF → 403.
- [x] WS-повідомлення і WS upgrade відкликаної сесії відхиляються (`wsSessionHandler` → `missing`, `verifyUpgradeToken` → `missing`) навіть коли запис сесії ще в Redis — `session-revocation.pg.test.ts`.
- [x] **Redis недоступний під час `destroyAllSessions`** (fault-injection після кроку 2) → пароль змінено; після відновлення Redis сесія B → 401 **на першому ж запиті, без** повторного запуску очищення (тобто через звірку з БД, не через DEL). Той самий критерій для `logoutAll` і password-reset.
- [x] `logoutAll` при недоступному Redis: `users.sessionToken` ротовано, відповідь **`503`** (`service_unavailable`, `Retry-After: 1`, без `deletedCount`), усі старі сесії — 401, у тому числі сесія самого викликача: **повторити запит з тією самою сесією не можна**, клієнт входить знову (наслідок «ротація першою»).
- [x] **Конкурентність:** два одночасних `changePassword` з **однаковим правильним** старим паролем і **різними** новими → рівно один 200, другий 409/400; у БД — пароль переможця; обидві старі сесії відкликані; сесія переможця працює. Throttle не серіалізує — гарантію дає умовний UPDATE / row lock.
- [x] Регресія: звичайний логін/логаут/`logoutAll` без змін.

### Тести

- [x] `test:redis` + `test:pg` integration: усі критерії; конкурентний сценарій через `Promise.all` двох HTTP-запитів до реального Postgres; fault-injection на Redis (паттерн у `csrf-bootstrap.redis.test.ts`).
- [x] Unit на `sessionHandler`: невідповідність `userToken` → сесія знищена, 401; **БД недоступна під час перевірки → 503, сесія не знищена і не пропущена**; анонімна сесія — без запиту до БД.
- [x] Бенчмарк `auth_guard` до/після (p50/p95 на локальному Postgres) у `progress.md` — вхідні дані для рішення про feat-061 (кеш).

---

## B2 · ✅ feat-060 · Гонка одноразових токенів (reset / verification / link)

**Гілка:** `fix/one-time-token-race` · **Залежності:** **B** (очищення сесій після commit тут best-effort і спирається на звірку `userToken` з B; без B reset-flow при збої Redis залишає старі сесії валідними — B2 не випускати окремо) · **Оцінка:** 0.5–1 д · Security-фікс, виконується **до** G і H4, не як частина тестового покриття.

### Факти з коду

- `password-reset-service.ts:553-585`: `findByTokenHash` → перевірка → зміна пароля → `markUsed`. `markUsed` (`password-reset-repository.ts:44-50`) — `UPDATE … WHERE id = ?` без `usedAt IS NULL`. Два одночасні запити з тим самим токеном обидва пройдуть перевірку і обидва змінять пароль. Аналогічно `email-verification-repository.ts`, `email-link-verification-repository.ts`.

### Зміни

- [x] У трьох репозиторіях: `markUsed(id)` → `UPDATE … SET used_at = now() WHERE id = ? AND used_at IS NULL RETURNING *`; 0 рядків → `undefined`.
- [x] Claim-then-act **у одній транзакції** (`db.transaction`): споживання токена (умовний UPDATE) → зміна пароля / верифікація email / лінк → commit. Помилка на будь-якому кроці → rollback → токен **не** втрачений, користувач може повторити.
- [x] Транзакція — `withTransaction` + необовʼязковий `executor` у `markUsed` та `userRepository.update` (`app/repositories/transaction.ts`). Окремої `consumeTokenAndApply` не вводив: у трьох місцях це 6–10 рядків, спільна функція зʼявиться в H4, коли буде видно, що справді спільне.
- [x] `destroyAllSessions` після commit — поза транзакцією (best-effort, див. B).

### Критерії приймання

- [x] Два одночасні `resetPassword` з одним токеном → рівно одне 200, друге — «invalid or used»; у БД пароль із запиту-переможця.
- [x] **Fault-injection** між споживанням токена і зміною пароля (помилка БД / кинутий exception в `apply`) → транзакція відкочена, токен досі `used_at IS NULL`, повторний запит із тим самим токеном → 200.
- [x] Те саме для email-verification і email-link.
- [x] Expired-токен → помилка, не споживається (або споживається — зафіксувати поточну поведінку і не змінювати).

### Тести

- [x] `test:pg`: `Promise.all` двох запитів; fault-injection через мок `userRepository.update`, що кидає всередині транзакції.

---

**Поза обсягом (перевірено):** phone-reset (`completePhonePasswordReset`) уже робить claim умовним `markConfirmed` (`confirmed_at IS NULL AND invalidated_at IS NULL AND expires_at > now`) **до** зміни пароля, тож подвійного застосування немає; збій після claim лише «спалює» SMS-код (безпечна сторона). Транзакційність цього флоу — частина H5 (SMS challenge).

---

## C · ✅ feat-062 · Відкликання admin-доступу у WebSocket

**Гілка:** `fix/ws-admin-revoke` · **Залежності:** немає · **Оцінка:** 1 д

### Факти з коду

- `app/websocket/ws-coordinator.ts:21-24` читає роль один раз при connect; `ws-admin-guard.ts:11` перевіряє `userData.role`.
- `admin-ws-channel-service.ts:14-27` робить `ws.subscribe(ADMIN_CHANNEL)` один раз. Повторна перевірка ролі в guard **не знімає підписку** — demoted admin продовжує отримувати broadcast без жодного запиту.
- Ping тримає сокет вічно (`ws-handlers.ts:215-223`). Інстансів може бути кілька — локальна `Map` не гарантує відкликання на всіх.

### Що виявилося при реалізації (відхилення від початкового плану)

- **Шар 1 (pub/sub «роль змінена») не реалізовано — у нього немає продюсера.** План припускав «місце зміни ролі в `app/services/admin/*`», але **жоден код застосунку не змінює `users.role`** після створення: ендпоінта немає (`auth.md`: «Зміна ролі — ендпоінта немає»), `userRepository.update` ролі не пише, seed наявних користувачів не оновлює (`exists_without_admin_role` → skip). Роль міняють у БД поза застосунком, і жодна подія про це не публікується. Канал, у який ніхто не пише, був би спекулятивним кодом. Коли зʼявиться код зміни ролі, він має викликати `adminWsChannelService.revokeAdminAccess` на інстансі (для швидкості) — гарантію все одно дає шар 2.
- **Шар 2 (періодична перевірка з БД) — єдиний механізм, що бачить зміни поза застосунком**, і він працює на кожному інстансі окремо, без Redis і без повідомлень між інстансами. Тому «Максимальний час відкликання» тут — це вся гарантія, а не страховка.
- **Перевірка лише знімає доступ, не видає.** Підвищення на відкритому зʼєднанні не віддзеркалюється (потрібен reconnect): ескалація привілеїв під час роботи зʼєднання не з'являється з фонового таймера.
- **Зʼєднання не закривається (`4403` не використано):** воно стає звичайним (канал знято, роль `user`), адмін-маршрути дають `403`. Закриття відключило б і його звичайні функції (чат підтримки) заради нічого.
- **`ws_admin_guard` не перечитує БД на кожен запит:** він читає ту саму `userData.role`, яку оновлює перевірка, тож затримка в нього та сама, що й у broadcast. Окремий кеш із TTL дублював би механізм.

### Зміни

- [x] `adminWsAccessService.recheckAdminConnections()`: бере з `wsConnectionRegistry.listConnections()` зʼєднання з роллю `admin`, **одним запитом** (`userRepository.findRolesByIds`) читає ролі їхніх користувачів, для кожного, чия роль не `admin` (або користувача видалено), викликає `adminWsChannelService.revokeAdminAccess(ws)` (відписка від каналу `admin`, `isAdminChannelSubscribed = false`, лічильник підписників, роль `user`). Закрите під час запиту зʼєднання пропускається.
- [x] Таймер `start()` / `stop()`: інтервал `WS_ADMIN_RECHECK_INTERVAL_MS` (за замовчуванням 30 с, ціле 100…3600000, інакше помилка на старті), один прохід за раз, помилка проходу логується й не зупиняє таймер, `unref()`, зупинка при graceful shutdown (`index.ts`).
- [x] **Запит ролей обмежений і скасовується** (рев'ю feat-062): він іде через пул перевірки сесії (`statement_timeout` на сервері, `query_timeout` у драйвері), а не через основний пул без таймаутів. Проходи йдуть по одному (`running`), тож запит, що ніколи не завершується, зупинив би всі наступні проходи — і відкликання, і graceful shutdown. Відтворено блокуванням таблиці `users`: до виправлення за 1.7 с був один прохід, тепер їх ≥ 2, а після зняття блокування доступ відкликається.
- [x] Помилки відкликання не ховаються: пропускається лише закритий сокет (`Invalid access of closed uWS.WebSocket`), решта логується (`error`), рахується в `failed` звіту проходу й не зупиняє інші зʼєднання.
- [x] Максимальний час відкликання задокументований в `documentation/backend/websocket.md` («Відкликання admin-доступу»): `WS_ADMIN_RECHECK_INTERVAL_MS` + тривалість одного проходу; не миттєво.
- [x] `ws-connection-registry.listConnections()`, `userRepository.findRolesByIds()`, `config/websocket.ts`, `.env.example`, `configuration.md`, `auth.md`.
- [ ] ~~Pub/sub `user-role-changed`~~ — немає продюсера (див. вище).
- [ ] ~~`ws_admin_guard` з окремим TTL-кешем~~ — читає роль, яку оновлює перевірка (див. вище).

### Критерії приймання (відповідають реальним гарантіям)

- [x] Після пониження в БД admin-broadcast на відкритому зʼєднанні припиняється не пізніше ніж через інтервал + прохід (у тесті інтервал 200 мс), інший адмін не зачеплений, зʼєднання лишається відкритим — `admin-ws-revocation.pg.test.ts` (справжній uWebSockets.js-сервер, справжні WebSocket-клієнти, Redis, PostgreSQL).
- [x] Наступний admin WS-маршрут від пониженого → `403`, повторна підписка неможлива.
- [x] Усі зʼєднання пониженого користувача відкликаються; видалений користувач = не адмін.
- [x] Перепідключення пониженого — звичайне зʼєднання, `403` на підписку.
- [x] Підвищення на відкритому зʼєднанні не дає доступу; після reconnect — дає.
- [x] БД недоступна під час проходу: нічого не змінюється й не падає, після відновлення — відкликає.
- [x] HTTP admin-роути — без змін (`admin_guard` читає БД на кожен запит).
- [ ] ~~Тест із двома реєстрами на спільному Redis і пропущеною подією~~ — подій немає; перевірка незалежна на кожному інстансі, тож двох інстансів у тесті не потрібно (кожен перечитує власні зʼєднання з БД).

### Тести

- [x] `admin-ws-revocation.pg.test.ts` (9 тестів, PostgreSQL + Redis, реальні WebSocket); мутація «перевірка ніколи не стартує» → 6 з 9 падають (3 пройдені — базова лінія, перепідключення, підвищення — від перевірки не залежать).
- [x] Юніт: `admin-ws-access-service.spec.ts` (вибірка лише admin-зʼєднань, один запит, демоут, видалений користувач, закриті зʼєднання, помилка БД, таймер: інтервал, один таймер, без накладання проходів, помилка не зупиняє), `admin-ws-channel-service.spec.ts` (`revokeAdminAccess`), `config/websocket.spec.ts`.

---

## D · ✅ feat-063 · Resource limits: support chat + multipart

**Гілка:** `fix/resource-limits` · **Залежності:** A (конфлікти в `http-routes.ts`) · **Оцінка:** 2 д

### D0. Як клієнт отримує відмову — спочатку контракт

- Факт: `app/controllers/ws/support-controller.ts:36-44` робить `void supportService.chat(...)` і одразу повертає `{ status: 'ok' }`. Перевірка бюджету/throttle всередині сервісу **не** перетвориться на відмову клієнту — він побачить `ok` і нічого не отримає.
- [x] Розділити `supportService.chat` на `admit(userId, message): Promise<AppResult<Admission>>` (синхронно: валідація довжини, throttle, inflight-lock, резерв бюджету) і `run(admission, ...)` (асинхронно: LLM-pipeline). Контролер: `admit` → при помилці повертає `appErrorToWsError(tooManyRequests(...))` замість `ok`; при успіху — `void run(...)` і `{ status: 'ok' }`.
- [x] Для відмов, що виникають **після** admit (помилка провайдера, timeout, бюджет вичерпаний посеред pipeline) — **наявна** broadcast-подія `support_chat_error` (`support-service.ts:158,219`; схема `shared/src/schemas/ws/broadcast-events.ts:13` `{ message: 'string' }`; frontend `useBroadcastHandler.ts:35` → `eventBus`). Розширити схему полем `'code?': 'string'` (backward-compatible), щоб клієнт відрізняв 429/budget від провайдерської помилки. Нову подію **не** вводити.
- [x] (без disable input на `retryAfter` — відмова повертає текст у поле вводу й показує повідомлення; відкладено як необов'язкове) Frontend `SupportView.vue`: обробка WS-відповіді з `status: 'error'` на `support_chat` (429 → повідомлення + disable input на `retryAfter`) і наявного `support_chat_error` з новим `code`.
- [x] Контракт описано в `documentation/backend/ai.md` (розділ «Допуск повідомлення») і `websocket.md`; окремих `support.md` та `openapi/` у репозиторії немає.

### D1. Support chat — розмір, частота, одночасність

- [x] `packages/shared/src/schemas/support/support-chat.ts:4` — `message: 'string >= 1 & string <= 4000'`; `SUPPORT_MESSAGE_MAX_LENGTH` у `shared`.
- [x] `config/throttle-policies.ts` — `supportChatUser` (напр. 20/хв), `supportOpenChatUser` (напр. 5/хв) — через існуючий атомарний `consumeAuthThrottle`.
- [x] **Inflight-lock з власником**: `SET support:inflight:<userId> <ownerToken> NX PX <ttl>`; зняття — **умовне** (Lua: `if GET == token then DEL`), а не голий `DEL` у `finally` — інакше запит, що пережив TTL, видалить lock наступного. `ownerToken = nanoid()` на admit.
- [x] (спершу обрано фіксований TTL; після рев'ю #207 замінено на **lease з heartbeat**: TTL 30 с, продовження кожні 5 с, втрата lease зупиняє відповідь) TTL lock'а = сумарний timeout усього pipeline (translation + embedding + chat, з `config/ai.ts` timeouts) + запас; **або** heartbeat-продовження (`PEXPIRE` раз на N s, лише якщо `GET == token`). Обрати одне, зафіксувати.
- [x] Усе це в `admit` (D0), до першого LLM-виклику; `openChat` greeting — під тим самим lock.
- [x] Frontend `SupportView.vue` — `maxlength` + лічильник зі shared-константи.

### D2. LLM-бюджет — атомарне резервування, консервативне списання

- Факти: `llm-usage-service.ts:27-44` `recordText` — fire-and-forget, помилка лише логується, `totalTokens` може бути `null`. Перевірка «залишок → запуск» не атомарна: N паралельних запитів бачать той самий залишок.
- [x] Дизайн (ADR 0003 у `docs/adr/0003-llm-budget-reservation.md`; замість `AI_BUDGET_RESERVE_RATIO` — `AI_SUPPORT_PROMPT_ALLOWANCE_TOKENS`, див. ADR):
    - **Перевірка + резервування — одна атомарна операція**: Lua-скрипт `budget_reserve(key, reserve, limit)` → `if current + reserve > limit then return -1 else INCRBY and return new`. Ключ `llm:budget:<userId>:<YYYY-MM-DD>` (TTL 48h). Жодного `DECRBY` на відмові — скрипт просто не інкрементує.
    - **Розмір резерву** — консервативна оцінка всього pipeline, не `promptChars/3`: `estimateTokens(prompt)` з токенайзером провайдера, якщо доступний; інакше евристика `promptChars / 2` — **це евристика, не верхня межа** (для CJK/emoji/коду співвідношення може бути гіршим). Плюс `maxOutputTokens` для chat (це справжня межа виходу) + оцінка translation + embedding. Зафіксувати в документації: «бюджет — приблизний; резерв — оцінка, звірка з фактичним usage коригує в обидва боки; гарантія — лише на порядок величини, не точна межа».
    - **Правила повернення резерву** (ключове): **до** першого запиту до провайдера (помилка валідації, lock не взято, abort до send) → `DECRBY reserve` повністю. **Після** початку будь-якого платного виклику → **ніколи** повний повернення: якщо провайдер повернув usage — `INCRBY (actual − reserve)` (звірка вниз або вгору); якщо usage `null` (abort посеред стрімінгу, timeout, помилка провайдера без usage) — **резерв залишається списаним** як консервативний факт. Клієнт, що скасовує після старту генерації, платить резерв.
    - `context.signal` (abort) — перевіряти **до** send у кожному з трьох викликів; після send abort лише припиняє стрім, не повертає бюджет.
    - `llm_text_usage` — аудит як зараз; enforcement — тільки Redis.
- [x] `.env.example`, `config/ai.ts` (`AI_SUPPORT_DAILY_TOKEN_BUDGET`, `AI_BUDGET_RESERVE_RATIO`), `validate-runtime-config.ts` (бюджет > 0 у production-like), `documentation/backend/ai.md`.
- [ ] Адмін-ендпойнт для перегляду/скидання бюджету — опційно, окремим PR. **Не зроблено** (опційно за планом, окремим PR).

### D3. Історія чату — контракт, не тихе обрізання

- [x] `support-repository.ts:31-41` `getChatHistory` — **не** обрізати до 20 (це змінює UI). Розділити: `getChatHistoryPage(userId, { before, limit })` для UI з пагінацією (frontend `SupportView.vue` — «показати раніше») і `getRecentForContext(userId, 20)` для промпту.
- [x] Контракт описано в `documentation/backend/ai.md` (розділ «Історія чату»); окремого `support.md` у репозиторії немає.

### D4. Multipart — file-limit і body-limit окремо

- Факт: файл рівно 10 MiB не поміститься в body рівно 10 MiB через boundary та заголовки.
- [x] Опція route `maxBodySize` у `vendor/utils/routing/*`; `http-request-handlers.ts:28-41` `resolveMaxBodySize(kind, route)` = `min(route.maxBodySize, config[kind])`.
- [x] Для multipart-роутів: `maxBodySize = maxFileSize + 64 KiB` (запас на boundary/headers/додаткові поля), константа `MULTIPART_OVERHEAD`.
- [x] `server.ts:260-270` — pre-check `Content-Length` проти route-ліміту; `http-request-handlers.ts:110-129` — обрив потоку при перевищенні **посеред** `onData`, а не після накопичення.
- [x] `http-routes.ts:376-398` — група `avatar`: `maxBodySize: 10 MiB + overhead`, `rateLimit: { windowMs: 60_000, maxRequests: 10 }`; KB screenshot: `5 MiB + overhead`.
- [x] Документація: публічна сторінка про body limits (є `docs/plan/http-body-limits-plan.md`).

_Виконано в першому PR фази D (D4). Деталі: мід-стрімове переривання і ранній `Content-Length`-відказ уже були, бракувало лише ліміту на маршрут; тепер діє `min(глобальний за типом, route.maxBodySize)`. Серед нового: `maxBodySize` на маршруті методу без тіла чи з некоректним значенням — помилка на старті; playground (`bodyLimits`) показує ефективний ліміт; ліміти завантажень і `multipartBodyLimit()` — у `app/services/shared/upload-limits.ts`._

### Критерії приймання

- [x] 4001 символів → WS-відповідь `status: 'error'` 422 (не `ok`); 21-е повідомлення за хвилину → 429 у відповіді; друге повідомлення під час генерації → 429. _`support-chat-admission.pg.test.ts`: «refuses a longer one with a validation error, never ok» (`error:validation_failed`; LLM не викликається), «refuses the message over the per-user limit with 429» (`support_rate_limited`), «refuses a second message while the first is being answered» (`429:support_busy`)._
- [x] Lock: запит А пережив TTL, запит B взяв lock, А завершився → lock B **не** видалений (умовний DEL). _`support-inflight-lock.redis.test.ts`: «does not remove the lock of a newer request when an expired one is released»._
- [x] **Admission rollback:** lock отримано → резерв бюджету відхилено (Lua повернув −1) → lock **звільнено** в тому ж `admit`, клієнт отримав 429. Наступний запит цього юзера **одразу отримує lock** (не чекає TTL), але бюджет знову відхиляє admission → 429 з тим самим кодом; після відновлення квоти (у тесті — скидання ключа `llm:budget:*`) повторний запит проходить повністю. _`support-service.spec.ts`: «refuses a message over the budget with a 429 and frees the lock it took»; `support-chat-admission.pg.test.ts`: «refuses a message once the day is spent, calls nothing, and keeps the user unlocked» (після скидання ключа наступне повідомлення проходить). Окремо не перевіряється лише друга відмова підряд з тим самим кодом._
- [x] 10 паралельних запитів при залишку бюджету на 1 → рівно один проходить (Lua-атомарність). _`llm-budget-service.redis.test.ts`: «lets exactly as many of 20 parallel reservations through as fit» (20, а не 10; та сама атомарність Lua)._
- [x] Abort **до** send → резерв повернуто повністю. Abort **після** старту генерації, провайдер без usage → резерв списано. Провайдер повернув usage → списано факт (звірка). _До send: `support-service.spec.ts` «starts no call when the run stops first, so everything is refunded», `llm-budget-service.redis.test.ts` «gives everything back when no call was started». Після старту без usage: «keeps the estimate of a started call that never reported at all» і `support-chat-admission.pg.test.ts` «keeps the reserve of a call that was cut off without a report». З usage: «charges what a started call really used, below or above the estimate» і «leaves what the provider reported once the answer is complete»._
- [x] Помилка провайдера після send без usage → резерв списано (консервативно); клієнт отримав `support_chat_error` з `code`. _`support-chat-admission.pg.test.ts`: «reaches the client as support_chat_error with a code and frees the user»; `llm-budget-service.redis.test.ts`: «keeps the estimate of a started call whose usage is unknown»._
- [x] UI показує всю історію (пагінацією), промпт отримує 20 останніх. _Бекенд: `support-history-http.pg.test.ts` (останні 50, далі за курсором), `support-service.spec.ts` «is the last 20 messages, not the whole history». Фронтенд: `stores/__tests__/support.spec.ts` («shows earlier messages…»). E2E-тесту на кнопку «Показати раніше» немає._
- [x] Файл рівно 10 MiB на `/avatar/upload` → 200; 10 MiB + 1 байт → 413; body без `Content-Length` (chunked) 11 MiB → 413 до завершення читання (перевірити пам'ять/кількість прочитаних байтів); 20 паралельних 50 MB → жоден не буферизується повністю. _`vendor/start/upload-limits.transport.spec.ts` (реальний uWS): «accepts a file of exactly 10 MiB», «answers 413 when the whole body is one byte over the limit», «answers 413 to a chunked 50 MiB body long before it ends, having read about the limit», «does not buffer 20 parallel 50 MiB uploads»._

### Тести

- [x] `test:redis` для throttle/budget (включно з паралельними); unit + integration для multipart (`http-request-handlers.spec.ts` + реальний HTTP-запит через uWS у `test-support`). _`auth-throttle-service.redis.test.ts`, `llm-budget-service.redis.test.ts`, `support-inflight-lock.redis.test.ts`; multipart: `http-request-handlers.spec.ts`, `app/routes/upload-limits.spec.ts` і транспортний `upload-limits.transport.spec.ts`. PR: #206 (multipart), #207–#209 (admission і lease), #210 (бюджет), #211 (історія), #212 (done)._

---

## E · ✅ feat-064 · OAuth-токени провайдерів

**Гілка:** `fix/oauth-token-storage` · **Залежності:** немає · **Оцінка:** 1 д (міграція → окреме рев'ю)

- [x] Рішення: не зберігати (жоден код не читає `accessToken`/`refreshToken`). Якщо продукт планує offline-доступ до провайдера — зупинитися і натомість робити шифрування at rest ключем, окремим від `APP_KEY`.
- [x] `database/schema.ts:268-269` — видалити колонки; `oauth-account-repository.ts:54-57` — видалити `updateTokens`; `oauth-service.ts:324-331, 387-398, 426-437` — прибрати виклики.
- [x] Міграція `drizzle-kit generate` → `<ts>_drop_oauth_tokens/`; повторний `generate` → «No schema changes». Rollback-план: колонки nullable, тому down-міграція — просто `ADD COLUMN`.
- [x] `oauth-service.ts:113-115` — Facebook token у `Authorization: Bearer`, не в query.
- [x] `oauth-service.ts:284-287, 296, 406` — `maskEmailForLogs`.
- [x] `documentation/backend/` — oauth + database сторінки.

**Критерії:** усі три OAuth-flow (Google/GitHub/Facebook — або які є) проходять у spec; `test:pg` з міграцією зелений; у логах немає сирих email.

---

## F · ✅ Приватність і конфіг — чотири незалежні PR

Кожен — окремий feature з незалежним відкатом; між собою не залежать.

### F1 · ✅ feat-065 · `llm_text_usage.final_prompt` — політика збору та retention (1 д, потребує рішення продукту)

- Truncation **не** захищає PII. Потрібен контракт:
- [x] Зафіксувати в `documentation/backend/ai.md`: що збирається (повний промпт / метадані / hash+довжина), хто має доступ (`GET /admin/usage/text`), retention (напр. 30 днів), як очищаються вже записані дані.
- [x] Рекомендований дефолт для шаблону: `promptSha256` + `promptChars` + `feature` + токени; повний текст — лише при `AI_USAGE_STORE_PROMPTS=true` (default `false`) з retention-джобом.
- [x] Нові поля в схемі → міграція (`drizzle-kit generate`, повторний → «No schema changes»); `llm-usage-service.ts:27-44`; `llm-usage-controller.ts:43` — не віддавати `finalPrompt`, якщо збір вимкнений.
- [x] `src/scripts/purge-llm-prompts.ts` для вже записаних промптів + retention (cron або документований ручний запуск).
- **Критерії:** при `AI_USAGE_STORE_PROMPTS=false` у БД немає тексту промпту; purge-скрипт очищає існуючі рядки; `test:pg` з міграцією.

### F2 · ✅ feat-066 · Auth-контракт: unverified login і timing реєстрації (0.5 д)

- [x] `auth-service.ts:1155-1174` — unverified + правильний пароль → `invalidCredentials()` (401); verification-лист повторно у фоні з throttle (1/5 хв на акаунт). Контракт у `documentation/backend/auth.md`; `AuthModals.vue` — замінити спеціальний UI для 400 «Email verification required» (якщо є) на generic + «перевірте пошту».
- [x] `auth-service.ts:337-342` — strict registration: хешувати пароль до lookup email.
- **Критерії:** spec на 401 для unverified; обидві гілки реєстрації викликають hash (spy), timing-різниця в тесті < порогу.

### F3 · ✅ feat-067 · DB config: `PGSQL_SSL` і SQL-логер (0.25 д)

- [x] `PGSQL_SSL` env (`false | true | require`), `config/database.ts`, `db.ts:17`; `validate-runtime-config.ts` — warning при production-like і `ssl=false`.
- [x] `db.ts:31` — `logger: !appConfig.isProductionLike`.
- [x] `.env.example`, `documentation/backend/configuration.md`.
- **Критерії:** `test:pg` зелений з `PGSQL_SSL=false`; при `APP_IS_PRODUCTION=true` у stdout немає SQL-statement'ів (spec на logger-конфіг).

### F4 · ✅ feat-068 · Frontend/SW/playground — дрібне без зміни контрактів (0.25 д)

- [x] `frontend/src/views/UserAccount.vue:393, 420, 450` — `autocomplete="current-password"`; `:398, 403` — `new-password`; `name` на всіх.
- [x] `frontend/src/service-worker.ts:494-518` — same-origin перевірка URL; порівняння `pathname`, не `includes`.
- [x] `frontend/src/App.vue:168` — `?redirect=` лише `startsWith('/') && !startsWith('//')`.
- [x] `api-playground/src/stores/api-settings.ts:95` — значення headers у `sessionStorage`; `utils/base-api.ts:91-96` — редакція `authorization|cookie|.*token`; `vite.config.ts` — `esbuild.pure` як у frontend.
- **Критерії:** unit на SW url-перевірку і redirect-guard; playground не пише header-значення в localStorage (spec на store).

---

## G · ✅ feat-069 · Регресійне покриття перед рефакторингами

**Гілка:** `test/auth-regression-coverage` · **Залежності:** B, B2, F2 (щоб фіксувати вже правильну поведінку) · **Оцінка:** 2 д

Факт: `frontend/e2e/vue.spec.ts` — «loads login page»; `mobile-layout.spec.ts` — два layout-тести. Auth-flow, помилки, повторний submit, відкриття/закриття модалки — не покриті. Без цього розбиття `AuthModals.vue` і рефакторинг auth-сервісів не мають сітки. Security-фікс гонки токенів винесений у **B2** і виконується раніше; тут — лише покриття.

### G1. Backend — snapshot auth-поведінки

- [x] Для кожного публічного методу `auth-service`, `password-reset-service`, `email-verification-service`: таблиця «вхід → код/повідомлення/побічні ефекти (sessions, throttle keys, emails)» як spec із fixture'ами. Мета — щоб H1–H5 не змінили жодного рядка очікувань.
- [x] Snapshot HTML/text трьох email-шаблонів (до H3).
- [x] Регресійні spec'и на транзакційний `consumeTokenAndApply` з B2 — залишаються зеленими після H4.

### G2. Frontend e2e — UI-стани на mocks (Playwright `page.route`)

Швидкі, детерміновані, без backend; фіксують поведінку `AuthModals.vue` перед J.

- [x] Login email: успіх, неправильний пароль (401), throttle (429 → повідомлення + disabled), повторний submit під час loading (кнопка disabled, рівно один запит — `page.route` лічильник).
- [x] Login phone: start → код → confirm; неправильний код; resend cooldown (таймер).
- [x] Register email (strict і non-strict відповіді сервера); register phone.
- [x] Forgot password: submit → generic-повідомлення незалежно від відповіді.
- [x] Модалка: відкрити → заповнити → закрити → відкрити → стан скинутий; перемикання login ↔ register — зафіксувати поточну поведінку як є.
- [x] Валідація на клієнті: пароль < 8, email-формат, телефон-формат — повідомлення без запиту.

### G3. Frontend e2e — реальний backend (`test-support` + Postgres + Redis у CI)

Повільніші; перевіряють те, що mocks не можуть — відкликання сесій між контекстами.

- [x] Forgot password → лист (перехопити через test-mailer) → reset page → новий пароль → у **другому browser-context** стара сесія → 401 (підтверджує B через UI).
- [x] Account page: change password → поточний context працює далі (нова cookie), другий context → 401; WS у другому context закривається/відхиляє.
- [x] Login → logout all → другий context 401.
- [x] Один happy path register email → verify (лист) → login — наскрізна перевірка з реальним throttle.

**Критерії:** усі нові тести зелені на `main` + B + B2 + F2; G2 і G3 — окремі Playwright-проєкти (`e2e/mock/*`, `e2e/live/*`); `pnpm --filter frontend test:e2e` у CI (`.github/workflows/ci.yml`) запускає обидва — підтвердити, що e2e дійсно виконуються, а не лише unit; для G3 CI піднімає Postgres + Redis (паттерн із `pg-tests.yml`/`redis-tests.yml`).

---

> Виконано трьома PR: #231 (G1), #232 (G2), #233 (G3). Відхилення від тексту: G3 — окремий конфіг `playwright.live.config.ts` + `e2e-live/` (потрібні свій бекенд, база і збірка), а не проєкт `e2e/live/*`; «login phone: start → код → confirm» і «resend cooldown (таймер)» у UI входу немає — телефонні кроки це реєстрація й відновлення пароля, таймера немає (показується ISO-час); зафіксовано як є.

---

## H · ✅ Рефакторинг auth-сервісів — п'ять окремих PR

**Залежності для всіх:** B2, G, K1 · Принцип: поведінка не змінюється, spec'и з G1 — без правок очікувань. Кожен H — свій feature (`feat-070…074`), щоб відкат був незалежним.

### H1 · ✅ `enforceThrottle()` (0.5 д)

- [x] `auth-throttle-service.ts` — `enforceThrottle(policy, key, rejectMessage): Promise<AppResult<void>>`.
- [x] 32 входження у трьох сервісах — по файлу на коміт.
- [x] Критерій: усі throttle-spec'и зелені; Redis-ключі ті самі (перевірити назви у spec).

> Виконано PR #240: 20 входжень (email-verification 2, password-reset 4, auth 14); сигнатура `enforceThrottle(policy, key, { unavailable, rejected })` — кроки різняться двома повідомленнями, не одним. `requestPasswordReset` і `resendVerificationAfterUnverifiedLogin` свідомо не змінено (інша поведінка).

### H2 · ✅ `auth-normalize.ts` (0.5 д)

- [x] `normalizeEmail`, `normalizePhone`, `isChallengeExpired`, flow-константи; прибрати копії (`auth-service.ts:55,75,110,114`, `password-reset-service.ts:50,80,92`, inline `.trim().toLowerCase()` у `password-reset-service.ts:225`, `email-verification-service.ts:381,398`, `oauth-service.ts:294`, `db/seed/run-seed.ts:65`).
- [x] `normalizeEmail` — у `packages/shared/src/utils`, якщо frontend теж нормалізує.
- [x] Критерій: однакові результати на таблиці edge-кейсів (unicode, пробіли, регістр) до/після.

> Виконано PR #243. `normalizeEmail` лишається в backend (frontend e-mail не нормалізує). Дві копії без `trim` (ціль e-mail-link, e-mail від OAuth-провайдера) тепер теж роблять `trim`.

### H3 · ✅ Email templates (0.5 д)

- [x] `app/services/notifications/email-templates.ts` — `EMAIL_BRAND`, `escapeHtml`, `renderBrandedEmail(...)`.
- [x] Замінити три шаблони; критерій — snapshot з G1 байт-у-байт ідентичний.

> Виконано PR #245. Єдина реальна різниця шаблонів — дія (`button` з блоком запасного посилання або одне `link`), прехедер необов'язковий.

### H4 · ✅ One-time tokens (1 д)

- [x] `createTokenRepository(table)` → три репозиторії стають однорядковими.
- [x] `one-time-token.ts` — `hashToken`, `createToken`, `issueToken`, узагальнити транзакційний `consumeTokenAndApply` з B2 для трьох репозиторіїв.
- [x] Замінити issue/consume у `password-reset-service.ts:269-324, 544-580`, `email-verification-service.ts:247-306, 323-365, 432-446, 553-610`.
- [x] Три таблиці **не** зливати (міграція без виграшу); зафіксувати примітку.
- [x] Критерій: B2-тести на гонку і fault-injection зелені для всіх трьох токен-типів без змін очікувань.

> Виконано PR #247. Три таблиці не зливали. Захист claim (`used_at IS NULL`) тримають саме PG-тести (юніт-spec'и з моками його не бачать).

### H5 · ✅ SMS challenge (1–1.5 д)

- [x] `sms-challenge.ts` — `issueSmsChallenge(...)`, `verifySmsChallenge(...)`.
- [x] Замінити start (`auth-service.ts:405-562, 722-879`, `password-reset-service.ts:326-523`) і confirm (`auth-service.ts:564-640, 881-1014`, `password-reset-service.ts:661-798`).
- [x] Критерій: усі SMS-spec'и + G1 зелені; rollback-гілки покриті окремими spec'ами на `sms-challenge.ts`.

> Виконано PR #249. Окремі `issueSmsChallenge`/`verifySmsChallenge` у плані розбито на `findPendingChallenge`/`openChallenge`/`deliverChallenge`/`issueSmsChallenge`/`verifySmsCode`/`confirmChallenge`: порядок перевірок, 404 vs 400 для невідомого челенджа та правило «та сама сесія» різняться між флоу і лишились у них.

### H6 · ✅ Дрібне (можна в будь-який H або окремо)

- [x] `knowledge-base-service.ts` — `requireArticle(id)` ×7, `deleteScreenshotQuietly(key)` ×3. _#283: `requireArticle` замінив 5 блоків (план казав 7; шостий, `getScreenshotKey`, свідомо повертає `null` для відсутньої статті), `deleteScreenshotQuietly` — 3 видалення._
- [x] `appErrorToHttpPayload` + `appErrorToWsError` → один. _#283: `appErrorToPayload` у `services/shared/app-error-payload.ts`; `ws-error.ts` видалено._
- [x] `normalizePath`, `ab2str` — по одному helper'у. _#283: `vendor/utils/helpers/normalize-path.ts` і `ab2str.ts` (з тестами). Копія `normalizePath` в api-playground лишилась: пакет не залежить від backend._
- [x] `oauth-service.ts:11-29` — один generic `fetchJson<T>`. _#283._
- [x] `controllers/shared/require-user-id.ts` — замінити подвійні auth-перевірки (28 місць). _#283: `requireUserId` замінив 3 локальні копії і 5 inline-перевірок у `auth-controller.ts` (план казав 28 місць). Різниця: 4 handler'и, що питали лише `getUserId()`, тепер ще й `auth.check()`; відрізняється тільки для порожнього рядка як id (401 замість користувача 0)._
- [ ] Опційно, стиль: repository-інтерфейси → inference; `HttpError` базовий клас у `server.ts:390-483`. Лише за згодою команди. **Не зроблено** (за планом — лише за згодою команди).

---

## I · ✅ feat-075 · Frontend + shared dedup

**Гілка:** `refactor/frontend-shared-dedup` · **Залежності:** G2, G3, K2, K3 · **Оцінка:** 2 д

- [x] WS-транспорт у `packages/shared/src/ws-client/` без Vue-залежностей (core з `frontend/src/composables/useWebSocketConnection.ts`; типи з `websocket-types.ts`; `classifyWsMessage`; `normalizeApiPrefix`). Апки — тонкі обгортки. Spec на core у `shared/test`; існуючі spec'и обох апок зелені.
- [x] `event-bus.ts` — одна реалізація (mitt).
- [x] Пароль: `PASSWORD_MIN/MAX` у shared; `frontend/src/utils/validate-password.ts`; замінити `AuthModals.vue:201, 397-402, 470-475, 635-640`, `ResetPasswordView.vue:39-56`, `UserAccount.vue:138-143`. **Зміна поведінки:** реєстрація почне відхиляти > 32 символів на клієнті (сервер і так відхиляв) — зафіксувати в PR.
- [x] `AuthModals.vue:82-86` — `looksLikePhoneNumber` зі `shared/utils/phone`.
- [x] Entity id — один regex: `backend/.../entity-id.ts:1` і `frontend/.../ws-payload-guards.ts:16` через `shared/brands/ids.ts` (рішення: `brands/` залишити і використовувати).
- [x] Admin views: `useAdminUserDetailModal()`, `AdminFilterBar.vue`, `buildAdminQuery()` в `api.ts` (+ `encodeURIComponent` на `:546`), спільний `admin.css`.
- [x] `sentry-service.ts:100-175` — `sanitizeTree(value, { sensitive })`; `:241-247` — прибрати повторний прогін.
- [x] ArkType default: перевірити, чи поточна `@arktype/type` типізує `.default()`; якщо так — прибрати касти в `query/common.ts`, `admin.ts`, `usage.ts`, `types.ts`; якщо ні — `withDefault()` helper.

**Критерії:** `pnpm test` для shared/frontend/playground + G2/G3 e2e зелені; скриншоти admin-сторінок до/після.

> Виконано PR #255–#258. Відхилення: (1) WS-транспорт у shared перенесено **частково** — `classifyWsMessage` і `normalizeApiPrefix` у `shared/ws-client`; саме з'єднання (448/437 рядків) — не копії (застосунок: heartbeat, refresh токена, back-off рукостискань; playground: фіксований reconnect), тож спільне ядро означало б переробку close/reconnect-логіки — рішення власника; (2) `looksLikePhoneNumber` — у `shared/patterns`, а не `shared/utils` (той тягне `libphonenumber-js` у браузер); (3) повторний прогін breadcrumbs у `beforeSend` **збережено** (defence in depth); (4) у Users-view кнопки фільтра прийняли стиль History-view (ці два дрейфували).

---

## J · ✅ feat-076 · Frontend split big components

**Гілка:** `refactor/frontend-split-components` · **Залежності:** G2, G3, I · **Оцінка:** 2 д

- [x] `AuthModals.vue` → `AuthModalShell.vue` + `LoginModal.vue` + `ForgotPasswordFlow.vue` + `RegisterEmailForm.vue` + `RegisterPhoneFlow.vue`; `useAuthRequest()` (замість 7 `try/catch/finally`), `useCompleteSignIn()` (замість 3 копій); per-flow `reactive()`; props/emits `AuthModals.vue` незмінні (`Login.vue:235`). _#260 (`AuthModals.vue` лишився оболонкою на 203 рядки; кроки в `components/auth/`)._
- [x] `stores/state.ts` → `stores/push.ts` (або `usePushSubscriptions`), `utils/storage-url.ts`, UI-prefs окремо. _#261 (`state.ts` 559 → 126 рядків; `utils/push-device.ts` і `utils/storage-url.ts` з тестами)._
- [x] `main.ts:48-401` → `utils/sw-manager.ts` з одним `shouldNotify()`. _#262 (`main.ts` 401 → 56 рядків, 25 тестів)._
- [x] `MenuButton.vue:28-170` → `PwaInstallButton.vue`. _#263: логіка в `composables/usePwaInstallButton.ts`, пункт у `PwaInstallButton.vue`; `<pwa-install>` лишився в меню, бо `transform` dropdown зламав би його fixed-діалог. Принагідно виправлено `onUnmounted`, що не знімав слухачів._
- [x] `api-playground/TestForm.vue` → `useLoadTest()` з типізованим результатом; спільні helper'и з `TestFormWs.vue` у `utils/test-form-helpers.ts`; прибрати `any`. _#264 (859 → 558 рядків, без `any`; старий і новий компонент дали ідентичні результати на 15 сценаріях)._

**Критерії:** G2 (mocks) і G3 (live) e2e зелені без змін; ручний golden path у `progress.md`.

---

## K · 🟢 Dead code — три вузькі PR (паралельно з A–F)

Перед кожним видаленням: `grep -rn "<name>" packages --include='*.ts' --include='*.vue' | grep -v spec` → 0 production-результатів. Критерій для всіх: `pnpm build` + typecheck + lint + test зелені; `git diff --stat` у `progress.md` як статистика.

### K1 · ✅ feat-077 · Backend (0.5 д)

- [x] `vendor/utils/helpers/normalize-user-id.ts`, `helpers/index.ts`; закоментована копія `redis-session-storage.ts:10-43`; `toCanonicalEntityId`, `isAuthorizedEntityRequest` в `entity-id.ts`.
- [x] `app/middlewares/test-middleware{,-2,-3,-4}.ts` + `kernel.ts:1-4, 20-23`.
- [x] `get-typed-payload.ts:22-67` (`getTypedQuery`, `isHttpContext`, `isWsContext`); `session-access.ts`; `applyAppError`; `tryDomain`; `app-error-samples.ts` → у spec; `staticIndexHandler`; `vendor/types/types.d.ts` 5 типів.
- [x] `app/validate/schemas/common/pagination.ts` + spec; `arktype-inference.spec.ts`.
- [x] Закоментований код: `index.ts:4,8-9,21-36`; `ws-context.ts:12-28,42-45`; `session-handler.ts:1-2,55-61`.
- [x] `serialize-routes.ts:866-951` — лише `isArkType → serializeArkSchema`; `serialize-routes.spec.ts:699-792`.

> Виконано PR #236. Свідомо не чіпали гілки `serialize-routes.ts` (не-ArkType `describe()`) — це задокументований контракт feat-041, номери рядків плану застарілі; рішення за власником. Додатково видалено `parse-user-agent.ts` (став без імпортів після barrel).

### K2 · ✅ feat-078 · Shared (0.25 д)

- [x] `schemas/auth/register.ts` (дублікат `register-email.ts`); `schemas/activity/` цілком; `index.ts`.
- [x] `schemas/query/common.ts:68-84` — прибрати з публічного експорту (або видалити зі spec).
- [x] `errors/error-codes.ts`, `csrf-reasons.ts`:
    ```ts
    export const ErrorCodeValues: readonly ErrorCode[] = Object.values(ErrorCode)
    ```
    (не `as const` на результаті виклику). Якщо десь потрібен літеральний tuple-тип — залишити ручний масив і `satisfies`, а sync-тест у `shared/test/contracts.test.js:16-24` тоді залишається.
- [x] `brands/` — залишити (використовується в I).

> Виконано PR #251. `ErrorCodeValues = Object.values(ErrorCode)` (тип `readonly ErrorCode[]`) — `ErrorCodeSchema` лишився union; `CSRF_REJECT_REASONS` не мав користувачів, окрім власного sync-тесту, і видалений.

### K3 · ✅ feat-079 · Frontend (0.25 д)

- [x] `main.ts:368` — мертва гілка `'NEW_VERSION'`.
- [x] `stores/state.ts:335` `getClientIP` stub; `:262-330` UA-sniffing — **тільки якщо** backend не використовує `browserName/osName/deviceType` (перевірити `push-subscription-service`, admin-view'и, транформер). Якщо використовує — це зміна контракту → окремий пункт з UA-парсингом на сервері.
- [x] `composables/useSentry.ts` → прямий імпорт.

> Виконано PR #253. UA-парсинг push-підписки **залишено**: backend зберігає `browserName/osName/deviceType` (колонки `push_subscriptions`, схеми shared, відповідь) — це контракт; перенесення парсингу на сервер — рішення власника.

---

## L · ✅ feat-080 · Repo hygiene (0.5 д, паралельно)

- [x] `progress.md`, `session-handoff.md` — прибрати з `main` (або «see feature branch»); перевірити `init.sh`, `AGENTS.md`. _#267, #268: «Mark done» PR видаляє їх з `main`; правило в `AGENTS.md`._
- [x] `.gitignore` + `.pnpm-store/`; `.dockerignore` + `.claude/ .idea/ .omx/ .pnpm-store/ docs/ documentation/ presentation.html`. _#267. Відхилення: `documentation/` і `docs/support-knowledge-base` **не** додано в `.dockerignore` (перше — член pnpm-workspace, потрібний `--frozen-lockfile`; друге копіює `Dockerfile`); замість цілого `docs/` перелічено внутрішні підтеки._
- [x] `presentation.html` → `docs/presentations/`; `docs/screenshots/README.md:1`. _#267: перейменовано в `overview.html` (`presentation.html` збігається з `PRESENTATION.html` за регістром на macOS)._
- [x] `AGENTS.md` — `docs/` внутрішнє, `documentation/` публічне. _#267._
- [x] `eslint.config.ts:11-12` — не ігнорувати `*.js`/`*.mjs` поза `dist`; блок `eslint.configs.recommended` для JS; полагодити знайдене. _#267: JS лінтиться (recommended, без type info, `globals.node`); знайдено невидимі символи в регулярці `documentation/scripts/verify/lib.mjs`._
- [x] CI: `uses:` на commit SHA + коментар версії; `.github/dependabot.yml` для `github-actions`. _#267: усі `uses:` закріплено на SHA з версією в коментарі, `.github/dependabot.yml` щотижня._
- [x] Критерій: `docker build` локально; `pnpm docs:build && pnpm docs:verify`. _`docker build .` проходить, `docs:build` і `docs:verify` зелені._

---

## M · ✅ feat-081 · Schema (окремий PR з міграцією, 0.5 д)

- [x] `schema.ts:305-307` `llm_text_usage.user_id` → `onDelete: 'set null'` — **рішення продукту**: чи usage-історія переживає видалення юзера (GDPR-міркування: `set null` зберігає промпт без зв'язку з юзером — узгодити з F1). _Рішення власника: `set null`. #278; текст промпту прибирає `llm:purge-prompts` за віком, чий би рядок не був; історія чату, навпаки, видаляється разом з користувачем._
- [x] `schema.ts:360` `support_chat_history` → індекс `(user_id, created_at)`. _#278: індекс `(user_id, created_at)` замінив `(user_id)` (старий був його префіксом)._
- [x] Одна міграція; `drizzle-kit generate` повторно → «No schema changes»; `test:pg`; `documentation/backend/database.md`. _#278: `20261102053350_llm_usage_set_null_support_history_index`; повторний `generate` — «No schema changes»; `schema-feat-081.pg.test.ts` (3 тести, 2 падають без міграції); `database.md` оновлено._

---

## N · ✅ feat-082 · Env-парсери — єдиний контракт (0.5 д)

**Зміна поведінки**, тому окремо від H: `config/auth.ts:1-7` приймає `'1'|'true'`, `vendor/utils/env/parse-boolean.ts` — ще `'yes'|'on'`; `parseNumberFlag` (`auth.ts:9-16`) через `Number()` приймає `1e3`, `0x10`, від'ємні.

- [x] Контракт у `documentation/backend/configuration.md`: boolean = `true|1|yes|on` / `false|0|no|off` (case-insensitive), інше — config error; integer = десяткове, в межах `{min,max}`, інше — config error. _#275, розділ «Булеві та цілі значення»._
- [x] `vendor/utils/env/read-int.ts`; усі boolean через `parse-boolean.ts`; `config/auth.ts` підключити до `validate-runtime-config.ts`. _#275: `parse-boolean.ts`, `read-int.ts`, `env-reader.ts`; `app`, `auth`, `mail`, `cors`, `network`, `sentry`, `session` тепер мають `configError`, який перевіряє `validateRuntimeConfig`._
- [x] Замінити `readInt/readInteger/readTimeoutMs/readPromptCacheTtlMs/parsePort/parseNumberFlag`. _#275. `database.ts` лишив власний `parsePort` з тим самим правилом «лише десяткові цифри», бо його завантажує drizzle-kit без path-аліасів._
- [x] Критерій: таблиця значень × змінних у spec; `AUTH_PHONE_ENABLED=yes` тепер `true`; `AUTH_*=1e3` → startup error з назвою змінної. _`vendor/utils/env/env-contract.spec.ts` (значення × парсер) і «env parsing contract» у `validate-runtime-config.spec.ts` (20 булевих і 18 цілих змінних кожна зупиняє старт з власним іменем; `AUTH_PHONE_ENABLED=yes` → `true`; `AUTH_*=1e3` → помилка з назвою)._

---

## O · ✅ feat-083 · Locale-стаби — рішення продукту (0.25 д після рішення)

**Зміна поведінки UI**, тому окремо: 17 файлів `locales/*.ts` — `export default en`; `APP_LOCALE_CODES` рекламує 18 мов.

- [x] Рішення: (a) показувати лише `en` до появи перекладів, або (b) залишити 18 у списку як «заплановані» з fallback на `en`. Узгодити з власником продукту. _Рішення власника: `en`, `uk`, `pl` (варіант (a) з `SHIPPED_LOCALE_CODES`)._
- [x] Реалізація: видалити стаби; `plugins/i18n.ts:46-54` `loadLocale` з fallback на `en` при невдалому `import()`; при (a) — `SHIPPED_LOCALES` у shared і фільтр у перемикачі. _#280: 15 стабів видалено, `uk.ts` і `pl.ts` — справжні переклади (**чернетка без носія мови**), `loadLocale` повертає `en` при невдалому `import()`. Принагідно: `SupportView` тепер шле Support AI мову браузера (`supportLanguage()`), а не мову інтерфейсу._
- [x] Критерій: вибір будь-якої локалі не ламає UI; e2e на перемикання. _`e2e/mock/locale.spec.ts` (uk, pl, en, ru, de, ja, невідома мова), `plugins/__tests__/locales.spec.ts`. Перемикача мови в UI немає: мова береться з браузера._

---

## Зведена таблиця

| #     | Feature      | Що                                                                                                  | Пріоритет | Залежності     | Оцінка  |
| ----- | ------------ | --------------------------------------------------------------------------------------------------- | --------- | -------------- | ------- |
| A     | feat-058     | IDOR push-підписок                                                                                  | ✅        | —              | 0.5 д   |
| B     | feat-059     | Відкликання сесій: звірка `userToken` з БД (без кешу), ротація в `changePassword`/`logoutAll`/reset | ✅        | A              | 1.5–2 д |
| B2    | feat-060     | Гонка одноразових токенів — транзакційний claim-then-act                                            | ✅        | **B**          | 0.5–1 д |
| B3    | feat-061     | Кеш `userToken` з визначеною `SESSION_REVOCATION_MAX_DELAY` (опційно, за бенчмарком з B)            | ⏸         | B              | 1 д     |
| C     | feat-062     | Відкликання WS admin: pub/sub + періодична перевірка підписок                                       | ✅        | —              | 1.5 д   |
| D     | feat-063     | Support chat: admit-контракт у WS, lock з власником, атомарний бюджет, multipart                    | ✅        | A              | 2.5 д   |
| E     | feat-064     | OAuth-токени (міграція)                                                                             | ✅        | —              | 1 д     |
| F1    | feat-065     | Prompt retention policy (міграція, purge)                                                           | ✅        | рішення        | 1 д     |
| F2    | feat-066     | Auth-контракт: unverified login, timing реєстрації                                                  | ✅        | —              | 0.5 д   |
| F3    | feat-067     | `PGSQL_SSL`, SQL-логер                                                                              | ✅        | —              | 0.25 д  |
| F4    | feat-068     | Frontend/SW/playground дрібне                                                                       | ✅        | —              | 0.25 д  |
| G     | feat-069     | Регресійне покриття: snapshot auth, e2e на mocks, e2e з реальним backend                            | ✅        | B, B2, F2      | 2 д     |
| H1–H5 | feat-070…074 | Auth refactor по кроку                                                                              | ✅        | B2, G, K1      | 4 д     |
| I     | feat-075     | FE/shared dedup                                                                                     | ✅        | G2, G3, K2, K3 | 2 д     |
| J     | feat-076     | FE split components                                                                                 | ✅        | G2, G3, I      | 2 д     |
| K1–K3 | feat-077…079 | Dead code backend / shared / frontend                                                               | ✅        | —              | 1 д     |
| L     | feat-080     | Repo hygiene, lint, CI pins                                                                         | ✅        | —              | 0.5 д   |
| M     | feat-081     | Schema (cascade, index)                                                                             | ✅        | F1 рішення     | 0.5 д   |
| N     | feat-082     | Env-парсери — контракт                                                                              | ✅        | —              | 0.5 д   |
| O     | feat-083     | Locale-стаби — рішення продукту                                                                     | ✅        | рішення        | 0.25 д  |

✅ — виконано; ⏸ — свідомо не робимо (feat-061: бенчмарк feat-059 і ADR 0002 не виправдовують кеш, причина в полі `evidence`).

Рішення, які потрібні від власника продукту до старту відповідної фази: F1 (що зберігати з промптів і скільки), D3 (пагінація історії в UI), M (usage після видалення юзера), O (список мов), K3 (чи потрібні `browserName/osName/deviceType` на сервері).

Рішено: M — `set null`, usage переживає видалення користувача; O — інтерфейс постачається мовами `en`, `uk`, `pl`.

## Що лишилося відкритим

- feat-061 (кеш `userToken`) — не плануємо, див. вище.
- D2: адмін-ендпойнт для перегляду/скидання бюджету — опційно, не зроблено.
- H6: стильові пункти (repository-інтерфейси → inference, базовий `HttpError`) — лише за згодою команди.
- C: три викреслені пункти (`~~…~~`) не потрібні, причини наведено в розділі.
- Питання до власника, що виникли під час роботи: дії при відкликанні сесії для вже відкритих WebSocket; помилки в записаних даних push (Android → `Linux`, iPhone → `macOS`) і чи переносити розбір user-agent на сервер; спільне ядро WS-з'єднання в `shared`; подвійний префікс у `getStorageFileUrl`; гілки `serialize-routes` без ArkType.
