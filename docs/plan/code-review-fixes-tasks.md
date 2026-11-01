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

## A · 🔴 feat-058 · IDOR у push-підписках

**Гілка:** `fix/push-subscription-idor` · **Залежності:** немає · **Оцінка:** 0.5 д

### Зміни

- [ ] `app/repositories/notifications/push-subscription-repository.ts:141-147` `update()` — `.returning()`, повертати `rows.at(0)`; прибрати `findById(id)`.
- [ ] `:166-172` `deactivate()` — те саме.
- [ ] `updateByEndpoint` (`:149-155`) — **не чіпати** `WHERE`: перенесення підписки між акаунтами після перевірки `p256dh`/`auth` ключів — навмисне (`push-subscription-service.ts:53-62`). Додати коментар у репозиторії, чому там немає `userId`.
- [ ] `app/services/notifications/push-subscription-service.ts:190-197, 271-286` — без змін логіки (`undefined → notFound`), перевірити, що немає інших місць, де результат `update`/`deactivate` вважається «свій».

### Критерії приймання

- [ ] Чужий id і неіснуючий id → однаковий 404 з однаковим тілом (без різниці у timing-чутливому тексті).
- [ ] Відповідь на чужий id не містить жодних полів чужого запису.
- [ ] Чужий запис після запиту незмінний (`updatedAt`, `lastUsedAt`, `isActive` — як були).
- [ ] Свій id → 200, оновлені поля.
- [ ] Перенесення підписки по `endpoint` з тими самими ключами на інший акаунт — працює як раніше (регресія на `updateByEndpoint`).

### Тести

- [ ] Integration (`test:pg`, реальний PostgreSQL, через HTTP-роут із `auth_guard`, два юзери): всі критерії вище. Не лише мок репозиторію.
- [ ] Unit у `push-subscription-repository.spec.ts`: `update` на 0 рядків → `undefined`.

---

## B · 🔴 feat-059 · Відкликання сесій при зміні пароля

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

## B2 · 🔴 feat-060 · Гонка одноразових токенів (reset / verification / link)

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

## C · 🔴 feat-062 · Відкликання admin-доступу у WebSocket

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

## D · 🟠 feat-063 · Resource limits: support chat + multipart

**Гілка:** `fix/resource-limits` · **Залежності:** A (конфлікти в `http-routes.ts`) · **Оцінка:** 2 д

### D0. Як клієнт отримує відмову — спочатку контракт

- Факт: `app/controllers/ws/support-controller.ts:36-44` робить `void supportService.chat(...)` і одразу повертає `{ status: 'ok' }`. Перевірка бюджету/throttle всередині сервісу **не** перетвориться на відмову клієнту — він побачить `ok` і нічого не отримає.
- [ ] Розділити `supportService.chat` на `admit(userId, message): Promise<AppResult<Admission>>` (синхронно: валідація довжини, throttle, inflight-lock, резерв бюджету) і `run(admission, ...)` (асинхронно: LLM-pipeline). Контролер: `admit` → при помилці повертає `appErrorToWsError(tooManyRequests(...))` замість `ok`; при успіху — `void run(...)` і `{ status: 'ok' }`.
- [ ] Для відмов, що виникають **після** admit (помилка провайдера, timeout, бюджет вичерпаний посеред pipeline) — **наявна** broadcast-подія `support_chat_error` (`support-service.ts:158,219`; схема `shared/src/schemas/ws/broadcast-events.ts:13` `{ message: 'string' }`; frontend `useBroadcastHandler.ts:35` → `eventBus`). Розширити схему полем `'code?': 'string'` (backward-compatible), щоб клієнт відрізняв 429/budget від провайдерської помилки. Нову подію **не** вводити.
- [ ] Frontend `SupportView.vue`: обробка WS-відповіді з `status: 'error'` на `support_chat` (429 → повідомлення + disable input на `retryAfter`) і наявного `support_chat_error` з новим `code`.
- [ ] Контракт у `documentation/backend/support.md` + WS-роут у `openapi/`.

### D1. Support chat — розмір, частота, одночасність

- [ ] `packages/shared/src/schemas/support/support-chat.ts:4` — `message: 'string >= 1 & string <= 4000'`; `SUPPORT_MESSAGE_MAX_LENGTH` у `shared`.
- [ ] `config/throttle-policies.ts` — `supportChatUser` (напр. 20/хв), `supportOpenChatUser` (напр. 5/хв) — через існуючий атомарний `consumeAuthThrottle`.
- [ ] **Inflight-lock з власником**: `SET support:inflight:<userId> <ownerToken> NX PX <ttl>`; зняття — **умовне** (Lua: `if GET == token then DEL`), а не голий `DEL` у `finally` — інакше запит, що пережив TTL, видалить lock наступного. `ownerToken = nanoid()` на admit.
- [ ] TTL lock'а = сумарний timeout усього pipeline (translation + embedding + chat, з `config/ai.ts` timeouts) + запас; **або** heartbeat-продовження (`PEXPIRE` раз на N s, лише якщо `GET == token`). Обрати одне, зафіксувати.
- [ ] Усе це в `admit` (D0), до першого LLM-виклику; `openChat` greeting — під тим самим lock.
- [ ] Frontend `SupportView.vue` — `maxlength` + лічильник зі shared-константи.

### D2. LLM-бюджет — атомарне резервування, консервативне списання

- Факти: `llm-usage-service.ts:27-44` `recordText` — fire-and-forget, помилка лише логується, `totalTokens` може бути `null`. Перевірка «залишок → запуск» не атомарна: N паралельних запитів бачать той самий залишок.
- [ ] Дизайн (ADR у `docs/adr/`):
    - **Перевірка + резервування — одна атомарна операція**: Lua-скрипт `budget_reserve(key, reserve, limit)` → `if current + reserve > limit then return -1 else INCRBY and return new`. Ключ `llm:budget:<userId>:<YYYY-MM-DD>` (TTL 48h). Жодного `DECRBY` на відмові — скрипт просто не інкрементує.
    - **Розмір резерву** — консервативна оцінка всього pipeline, не `promptChars/3`: `estimateTokens(prompt)` з токенайзером провайдера, якщо доступний; інакше евристика `promptChars / 2` — **це евристика, не верхня межа** (для CJK/emoji/коду співвідношення може бути гіршим). Плюс `maxOutputTokens` для chat (це справжня межа виходу) + оцінка translation + embedding. Зафіксувати в документації: «бюджет — приблизний; резерв — оцінка, звірка з фактичним usage коригує в обидва боки; гарантія — лише на порядок величини, не точна межа».
    - **Правила повернення резерву** (ключове): **до** першого запиту до провайдера (помилка валідації, lock не взято, abort до send) → `DECRBY reserve` повністю. **Після** початку будь-якого платного виклику → **ніколи** повний повернення: якщо провайдер повернув usage — `INCRBY (actual − reserve)` (звірка вниз або вгору); якщо usage `null` (abort посеред стрімінгу, timeout, помилка провайдера без usage) — **резерв залишається списаним** як консервативний факт. Клієнт, що скасовує після старту генерації, платить резерв.
    - `context.signal` (abort) — перевіряти **до** send у кожному з трьох викликів; після send abort лише припиняє стрім, не повертає бюджет.
    - `llm_text_usage` — аудит як зараз; enforcement — тільки Redis.
- [ ] `.env.example`, `config/ai.ts` (`AI_SUPPORT_DAILY_TOKEN_BUDGET`, `AI_BUDGET_RESERVE_RATIO`), `validate-runtime-config.ts` (бюджет > 0 у production-like), `documentation/backend/ai.md`.
- [ ] Адмін-ендпойнт для перегляду/скидання бюджету — опційно, окремим PR.

### D3. Історія чату — контракт, не тихе обрізання

- [ ] `support-repository.ts:31-41` `getChatHistory` — **не** обрізати до 20 (це змінює UI). Розділити: `getChatHistoryPage(userId, { before, limit })` для UI з пагінацією (frontend `SupportView.vue` — «показати раніше») і `getRecentForContext(userId, 20)` для промпту.
- [ ] Зафіксувати контракт у `documentation/backend/support.md`.

### D4. Multipart — file-limit і body-limit окремо

- Факт: файл рівно 10 MiB не поміститься в body рівно 10 MiB через boundary та заголовки.
- [x] Опція route `maxBodySize` у `vendor/utils/routing/*`; `http-request-handlers.ts:28-41` `resolveMaxBodySize(kind, route)` = `min(route.maxBodySize, config[kind])`.
- [x] Для multipart-роутів: `maxBodySize = maxFileSize + 64 KiB` (запас на boundary/headers/додаткові поля), константа `MULTIPART_OVERHEAD`.
- [x] `server.ts:260-270` — pre-check `Content-Length` проти route-ліміту; `http-request-handlers.ts:110-129` — обрив потоку при перевищенні **посеред** `onData`, а не після накопичення.
- [x] `http-routes.ts:376-398` — група `avatar`: `maxBodySize: 10 MiB + overhead`, `rateLimit: { windowMs: 60_000, maxRequests: 10 }`; KB screenshot: `5 MiB + overhead`.
- [x] Документація: публічна сторінка про body limits (є `docs/plan/http-body-limits-plan.md`).

_Виконано в першому PR фази D (D4). Деталі: мід-стрімове переривання і ранній `Content-Length`-відказ уже були, бракувало лише ліміту на маршрут; тепер діє `min(глобальний за типом, route.maxBodySize)`. Серед нового: `maxBodySize` на маршруті методу без тіла чи з некоректним значенням — помилка на старті; playground (`bodyLimits`) показує ефективний ліміт; ліміти завантажень і `multipartBodyLimit()` — у `app/services/shared/upload-limits.ts`._

### Критерії приймання

- [ ] 4001 символів → WS-відповідь `status: 'error'` 422 (не `ok`); 21-е повідомлення за хвилину → 429 у відповіді; друге повідомлення під час генерації → 429.
- [ ] Lock: запит А пережив TTL, запит B взяв lock, А завершився → lock B **не** видалений (умовний DEL).
- [ ] **Admission rollback:** lock отримано → резерв бюджету відхилено (Lua повернув −1) → lock **звільнено** в тому ж `admit`, клієнт отримав 429. Наступний запит цього юзера **одразу отримує lock** (не чекає TTL), але бюджет знову відхиляє admission → 429 з тим самим кодом; після відновлення квоти (у тесті — скидання ключа `llm:budget:*`) повторний запит проходить повністю.
- [ ] 10 паралельних запитів при залишку бюджету на 1 → рівно один проходить (Lua-атомарність).
- [ ] Abort **до** send → резерв повернуто повністю. Abort **після** старту генерації, провайдер без usage → резерв списано. Провайдер повернув usage → списано факт (звірка).
- [ ] Помилка провайдера після send без usage → резерв списано (консервативно); клієнт отримав `support_chat_error` з `code`.
- [ ] UI показує всю історію (пагінацією), промпт отримує 20 останніх.
- [ ] Файл рівно 10 MiB на `/avatar/upload` → 200; 10 MiB + 1 байт → 413; body без `Content-Length` (chunked) 11 MiB → 413 до завершення читання (перевірити пам'ять/кількість прочитаних байтів); 20 паралельних 50 MB → жоден не буферизується повністю.

### Тести

- [ ] `test:redis` для throttle/budget (включно з паралельними); unit + integration для multipart (`http-request-handlers.spec.ts` + реальний HTTP-запит через uWS у `test-support`).

---

## E · 🟠 feat-064 · OAuth-токени провайдерів

**Гілка:** `fix/oauth-token-storage` · **Залежності:** немає · **Оцінка:** 1 д (міграція → окреме рев'ю)

- [ ] Рішення: не зберігати (жоден код не читає `accessToken`/`refreshToken`). Якщо продукт планує offline-доступ до провайдера — зупинитися і натомість робити шифрування at rest ключем, окремим від `APP_KEY`.
- [ ] `database/schema.ts:268-269` — видалити колонки; `oauth-account-repository.ts:54-57` — видалити `updateTokens`; `oauth-service.ts:324-331, 387-398, 426-437` — прибрати виклики.
- [ ] Міграція `drizzle-kit generate` → `<ts>_drop_oauth_tokens/`; повторний `generate` → «No schema changes». Rollback-план: колонки nullable, тому down-міграція — просто `ADD COLUMN`.
- [ ] `oauth-service.ts:113-115` — Facebook token у `Authorization: Bearer`, не в query.
- [ ] `oauth-service.ts:284-287, 296, 406` — `maskEmailForLogs`.
- [ ] `documentation/backend/` — oauth + database сторінки.

**Критерії:** усі три OAuth-flow (Google/GitHub/Facebook — або які є) проходять у spec; `test:pg` з міграцією зелений; у логах немає сирих email.

---

## F · 🟠 Приватність і конфіг — чотири незалежні PR

Кожен — окремий feature з незалежним відкатом; між собою не залежать.

### F1 · feat-065 · `llm_text_usage.final_prompt` — політика збору та retention (1 д, потребує рішення продукту)

- Truncation **не** захищає PII. Потрібен контракт:
- [ ] Зафіксувати в `documentation/backend/ai.md`: що збирається (повний промпт / метадані / hash+довжина), хто має доступ (`GET /admin/usage/text`), retention (напр. 30 днів), як очищаються вже записані дані.
- [ ] Рекомендований дефолт для шаблону: `promptSha256` + `promptChars` + `feature` + токени; повний текст — лише при `AI_USAGE_STORE_PROMPTS=true` (default `false`) з retention-джобом.
- [ ] Нові поля в схемі → міграція (`drizzle-kit generate`, повторний → «No schema changes»); `llm-usage-service.ts:27-44`; `llm-usage-controller.ts:43` — не віддавати `finalPrompt`, якщо збір вимкнений.
- [ ] `src/scripts/purge-llm-prompts.ts` для вже записаних промптів + retention (cron або документований ручний запуск).
- **Критерії:** при `AI_USAGE_STORE_PROMPTS=false` у БД немає тексту промпту; purge-скрипт очищає існуючі рядки; `test:pg` з міграцією.

### F2 · feat-066 · Auth-контракт: unverified login і timing реєстрації (0.5 д)

- [ ] `auth-service.ts:1155-1174` — unverified + правильний пароль → `invalidCredentials()` (401); verification-лист повторно у фоні з throttle (1/5 хв на акаунт). Контракт у `documentation/backend/auth.md`; `AuthModals.vue` — замінити спеціальний UI для 400 «Email verification required» (якщо є) на generic + «перевірте пошту».
- [ ] `auth-service.ts:337-342` — strict registration: хешувати пароль до lookup email.
- **Критерії:** spec на 401 для unverified; обидві гілки реєстрації викликають hash (spy), timing-різниця в тесті < порогу.

### F3 · feat-067 · DB config: `PGSQL_SSL` і SQL-логер (0.25 д)

- [ ] `PGSQL_SSL` env (`false | true | require`), `config/database.ts`, `db.ts:17`; `validate-runtime-config.ts` — warning при production-like і `ssl=false`.
- [ ] `db.ts:31` — `logger: !appConfig.isProductionLike`.
- [ ] `.env.example`, `documentation/backend/configuration.md`.
- **Критерії:** `test:pg` зелений з `PGSQL_SSL=false`; при `APP_IS_PRODUCTION=true` у stdout немає SQL-statement'ів (spec на logger-конфіг).

### F4 · feat-068 · Frontend/SW/playground — дрібне без зміни контрактів (0.25 д)

- [ ] `frontend/src/views/UserAccount.vue:393, 420, 450` — `autocomplete="current-password"`; `:398, 403` — `new-password`; `name` на всіх.
- [ ] `frontend/src/service-worker.ts:494-518` — same-origin перевірка URL; порівняння `pathname`, не `includes`.
- [ ] `frontend/src/App.vue:168` — `?redirect=` лише `startsWith('/') && !startsWith('//')`.
- [ ] `api-playground/src/stores/api-settings.ts:95` — значення headers у `sessionStorage`; `utils/base-api.ts:91-96` — редакція `authorization|cookie|.*token`; `vite.config.ts` — `esbuild.pure` як у frontend.
- **Критерії:** unit на SW url-перевірку і redirect-guard; playground не пише header-значення в localStorage (spec на store).

---

## G · 🟡 feat-069 · Регресійне покриття перед рефакторингами

**Гілка:** `test/auth-regression-coverage` · **Залежності:** B, B2, F2 (щоб фіксувати вже правильну поведінку) · **Оцінка:** 2 д

Факт: `frontend/e2e/vue.spec.ts` — «loads login page»; `mobile-layout.spec.ts` — два layout-тести. Auth-flow, помилки, повторний submit, відкриття/закриття модалки — не покриті. Без цього розбиття `AuthModals.vue` і рефакторинг auth-сервісів не мають сітки. Security-фікс гонки токенів винесений у **B2** і виконується раніше; тут — лише покриття.

### G1. Backend — snapshot auth-поведінки

- [ ] Для кожного публічного методу `auth-service`, `password-reset-service`, `email-verification-service`: таблиця «вхід → код/повідомлення/побічні ефекти (sessions, throttle keys, emails)» як spec із fixture'ами. Мета — щоб H1–H5 не змінили жодного рядка очікувань.
- [ ] Snapshot HTML/text трьох email-шаблонів (до H3).
- [ ] Регресійні spec'и на транзакційний `consumeTokenAndApply` з B2 — залишаються зеленими після H4.

### G2. Frontend e2e — UI-стани на mocks (Playwright `page.route`)

Швидкі, детерміновані, без backend; фіксують поведінку `AuthModals.vue` перед J.

- [ ] Login email: успіх, неправильний пароль (401), throttle (429 → повідомлення + disabled), повторний submit під час loading (кнопка disabled, рівно один запит — `page.route` лічильник).
- [ ] Login phone: start → код → confirm; неправильний код; resend cooldown (таймер).
- [ ] Register email (strict і non-strict відповіді сервера); register phone.
- [ ] Forgot password: submit → generic-повідомлення незалежно від відповіді.
- [ ] Модалка: відкрити → заповнити → закрити → відкрити → стан скинутий; перемикання login ↔ register — зафіксувати поточну поведінку як є.
- [ ] Валідація на клієнті: пароль < 8, email-формат, телефон-формат — повідомлення без запиту.

### G3. Frontend e2e — реальний backend (`test-support` + Postgres + Redis у CI)

Повільніші; перевіряють те, що mocks не можуть — відкликання сесій між контекстами.

- [ ] Forgot password → лист (перехопити через test-mailer) → reset page → новий пароль → у **другому browser-context** стара сесія → 401 (підтверджує B через UI).
- [ ] Account page: change password → поточний context працює далі (нова cookie), другий context → 401; WS у другому context закривається/відхиляє.
- [ ] Login → logout all → другий context 401.
- [ ] Один happy path register email → verify (лист) → login — наскрізна перевірка з реальним throttle.

**Критерії:** усі нові тести зелені на `main` + B + B2 + F2; G2 і G3 — окремі Playwright-проєкти (`e2e/mock/*`, `e2e/live/*`); `pnpm --filter frontend test:e2e` у CI (`.github/workflows/ci.yml`) запускає обидва — підтвердити, що e2e дійсно виконуються, а не лише unit; для G3 CI піднімає Postgres + Redis (паттерн із `pg-tests.yml`/`redis-tests.yml`).

---

## H · 🟢 Рефакторинг auth-сервісів — п'ять окремих PR

**Залежності для всіх:** B2, G, K1 · Принцип: поведінка не змінюється, spec'и з G1 — без правок очікувань. Кожен H — свій feature (`feat-070…074`), щоб відкат був незалежним.

### H1 · `enforceThrottle()` (0.5 д)

- [ ] `auth-throttle-service.ts` — `enforceThrottle(policy, key, rejectMessage): Promise<AppResult<void>>`.
- [ ] 32 входження у трьох сервісах — по файлу на коміт.
- [ ] Критерій: усі throttle-spec'и зелені; Redis-ключі ті самі (перевірити назви у spec).

### H2 · `auth-normalize.ts` (0.5 д)

- [ ] `normalizeEmail`, `normalizePhone`, `isChallengeExpired`, flow-константи; прибрати копії (`auth-service.ts:55,75,110,114`, `password-reset-service.ts:50,80,92`, inline `.trim().toLowerCase()` у `password-reset-service.ts:225`, `email-verification-service.ts:381,398`, `oauth-service.ts:294`, `db/seed/run-seed.ts:65`).
- [ ] `normalizeEmail` — у `packages/shared/src/utils`, якщо frontend теж нормалізує.
- [ ] Критерій: однакові результати на таблиці edge-кейсів (unicode, пробіли, регістр) до/після.

### H3 · Email templates (0.5 д)

- [ ] `app/services/notifications/email-templates.ts` — `EMAIL_BRAND`, `escapeHtml`, `renderBrandedEmail(...)`.
- [ ] Замінити три шаблони; критерій — snapshot з G1 байт-у-байт ідентичний.

### H4 · One-time tokens (1 д)

- [ ] `createTokenRepository(table)` → три репозиторії стають однорядковими.
- [ ] `one-time-token.ts` — `hashToken`, `createToken`, `issueToken`, узагальнити транзакційний `consumeTokenAndApply` з B2 для трьох репозиторіїв.
- [ ] Замінити issue/consume у `password-reset-service.ts:269-324, 544-580`, `email-verification-service.ts:247-306, 323-365, 432-446, 553-610`.
- [ ] Три таблиці **не** зливати (міграція без виграшу); зафіксувати примітку.
- [ ] Критерій: B2-тести на гонку і fault-injection зелені для всіх трьох токен-типів без змін очікувань.

### H5 · SMS challenge (1–1.5 д)

- [ ] `sms-challenge.ts` — `issueSmsChallenge(...)`, `verifySmsChallenge(...)`.
- [ ] Замінити start (`auth-service.ts:405-562, 722-879`, `password-reset-service.ts:326-523`) і confirm (`auth-service.ts:564-640, 881-1014`, `password-reset-service.ts:661-798`).
- [ ] Критерій: усі SMS-spec'и + G1 зелені; rollback-гілки покриті окремими spec'ами на `sms-challenge.ts`.

### H6 · Дрібне (можна в будь-який H або окремо)

- [ ] `knowledge-base-service.ts` — `requireArticle(id)` ×7, `deleteScreenshotQuietly(key)` ×3.
- [ ] `appErrorToHttpPayload` + `appErrorToWsError` → один.
- [ ] `normalizePath`, `ab2str` — по одному helper'у.
- [ ] `oauth-service.ts:11-29` — один generic `fetchJson<T>`.
- [ ] `controllers/shared/require-user-id.ts` — замінити подвійні auth-перевірки (28 місць).
- [ ] Опційно, стиль: repository-інтерфейси → inference; `HttpError` базовий клас у `server.ts:390-483`. Лише за згодою команди.

---

## I · 🟢 feat-075 · Frontend + shared dedup

**Гілка:** `refactor/frontend-shared-dedup` · **Залежності:** G2, G3, K2, K3 · **Оцінка:** 2 д

- [ ] WS-транспорт у `packages/shared/src/ws-client/` без Vue-залежностей (core з `frontend/src/composables/useWebSocketConnection.ts`; типи з `websocket-types.ts`; `classifyWsMessage`; `normalizeApiPrefix`). Апки — тонкі обгортки. Spec на core у `shared/test`; існуючі spec'и обох апок зелені.
- [ ] `event-bus.ts` — одна реалізація (mitt).
- [ ] Пароль: `PASSWORD_MIN/MAX` у shared; `frontend/src/utils/validate-password.ts`; замінити `AuthModals.vue:201, 397-402, 470-475, 635-640`, `ResetPasswordView.vue:39-56`, `UserAccount.vue:138-143`. **Зміна поведінки:** реєстрація почне відхиляти > 32 символів на клієнті (сервер і так відхиляв) — зафіксувати в PR.
- [ ] `AuthModals.vue:82-86` — `looksLikePhoneNumber` зі `shared/utils/phone`.
- [ ] Entity id — один regex: `backend/.../entity-id.ts:1` і `frontend/.../ws-payload-guards.ts:16` через `shared/brands/ids.ts` (рішення: `brands/` залишити і використовувати).
- [ ] Admin views: `useAdminUserDetailModal()`, `AdminFilterBar.vue`, `buildAdminQuery()` в `api.ts` (+ `encodeURIComponent` на `:546`), спільний `admin.css`.
- [ ] `sentry-service.ts:100-175` — `sanitizeTree(value, { sensitive })`; `:241-247` — прибрати повторний прогін.
- [ ] ArkType default: перевірити, чи поточна `@arktype/type` типізує `.default()`; якщо так — прибрати касти в `query/common.ts`, `admin.ts`, `usage.ts`, `types.ts`; якщо ні — `withDefault()` helper.

**Критерії:** `pnpm test` для shared/frontend/playground + G2/G3 e2e зелені; скриншоти admin-сторінок до/після.

---

## J · 🟢 feat-076 · Frontend split big components

**Гілка:** `refactor/frontend-split-components` · **Залежності:** G2, G3, I · **Оцінка:** 2 д

- [ ] `AuthModals.vue` → `AuthModalShell.vue` + `LoginModal.vue` + `ForgotPasswordFlow.vue` + `RegisterEmailForm.vue` + `RegisterPhoneFlow.vue`; `useAuthRequest()` (замість 7 `try/catch/finally`), `useCompleteSignIn()` (замість 3 копій); per-flow `reactive()`; props/emits `AuthModals.vue` незмінні (`Login.vue:235`).
- [ ] `stores/state.ts` → `stores/push.ts` (або `usePushSubscriptions`), `utils/storage-url.ts`, UI-prefs окремо.
- [ ] `main.ts:48-401` → `utils/sw-manager.ts` з одним `shouldNotify()`.
- [ ] `MenuButton.vue:28-170` → `PwaInstallButton.vue`.
- [ ] `api-playground/TestForm.vue` → `useLoadTest()` з типізованим результатом; спільні helper'и з `TestFormWs.vue` у `utils/test-form-helpers.ts`; прибрати `any`.

**Критерії:** G2 (mocks) і G3 (live) e2e зелені без змін; ручний golden path у `progress.md`.

---

## K · 🟢 Dead code — три вузькі PR (паралельно з A–F)

Перед кожним видаленням: `grep -rn "<name>" packages --include='*.ts' --include='*.vue' | grep -v spec` → 0 production-результатів. Критерій для всіх: `pnpm build` + typecheck + lint + test зелені; `git diff --stat` у `progress.md` як статистика.

### K1 · feat-077 · Backend (0.5 д)

- [ ] `vendor/utils/helpers/normalize-user-id.ts`, `helpers/index.ts`; закоментована копія `redis-session-storage.ts:10-43`; `toCanonicalEntityId`, `isAuthorizedEntityRequest` в `entity-id.ts`.
- [ ] `app/middlewares/test-middleware{,-2,-3,-4}.ts` + `kernel.ts:1-4, 20-23`.
- [ ] `get-typed-payload.ts:22-67` (`getTypedQuery`, `isHttpContext`, `isWsContext`); `session-access.ts`; `applyAppError`; `tryDomain`; `app-error-samples.ts` → у spec; `staticIndexHandler`; `vendor/types/types.d.ts` 5 типів.
- [ ] `app/validate/schemas/common/pagination.ts` + spec; `arktype-inference.spec.ts`.
- [ ] Закоментований код: `index.ts:4,8-9,21-36`; `ws-context.ts:12-28,42-45`; `session-handler.ts:1-2,55-61`.
- [ ] `serialize-routes.ts:866-951` — лише `isArkType → serializeArkSchema`; `serialize-routes.spec.ts:699-792`.

### K2 · feat-078 · Shared (0.25 д)

- [ ] `schemas/auth/register.ts` (дублікат `register-email.ts`); `schemas/activity/` цілком; `index.ts`.
- [ ] `schemas/query/common.ts:68-84` — прибрати з публічного експорту (або видалити зі spec).
- [ ] `errors/error-codes.ts`, `csrf-reasons.ts`:
    ```ts
    export const ErrorCodeValues: readonly ErrorCode[] = Object.values(ErrorCode)
    ```
    (не `as const` на результаті виклику). Якщо десь потрібен літеральний tuple-тип — залишити ручний масив і `satisfies`, а sync-тест у `shared/test/contracts.test.js:16-24` тоді залишається.
- [ ] `brands/` — залишити (використовується в I).

### K3 · feat-079 · Frontend (0.25 д)

- [ ] `main.ts:368` — мертва гілка `'NEW_VERSION'`.
- [ ] `stores/state.ts:335` `getClientIP` stub; `:262-330` UA-sniffing — **тільки якщо** backend не використовує `browserName/osName/deviceType` (перевірити `push-subscription-service`, admin-view'и, транформер). Якщо використовує — це зміна контракту → окремий пункт з UA-парсингом на сервері.
- [ ] `composables/useSentry.ts` → прямий імпорт.

---

## L · 🔵 feat-080 · Repo hygiene (0.5 д, паралельно)

- [ ] `progress.md`, `session-handoff.md` — прибрати з `main` (або «see feature branch»); перевірити `init.sh`, `AGENTS.md`.
- [ ] `.gitignore` + `.pnpm-store/`; `.dockerignore` + `.claude/ .idea/ .omx/ .pnpm-store/ docs/ documentation/ presentation.html`.
- [ ] `presentation.html` → `docs/presentations/`; `docs/screenshots/README.md:1`.
- [ ] `AGENTS.md` — `docs/` внутрішнє, `documentation/` публічне.
- [ ] `eslint.config.ts:11-12` — не ігнорувати `*.js`/`*.mjs` поза `dist`; блок `eslint.configs.recommended` для JS; полагодити знайдене.
- [ ] CI: `uses:` на commit SHA + коментар версії; `.github/dependabot.yml` для `github-actions`.
- [ ] Критерій: `docker build` локально; `pnpm docs:build && pnpm docs:verify`.

---

## M · 🔵 feat-081 · Schema (окремий PR з міграцією, 0.5 д)

- [ ] `schema.ts:305-307` `llm_text_usage.user_id` → `onDelete: 'set null'` — **рішення продукту**: чи usage-історія переживає видалення юзера (GDPR-міркування: `set null` зберігає промпт без зв'язку з юзером — узгодити з F1).
- [ ] `schema.ts:360` `support_chat_history` → індекс `(user_id, created_at)`.
- [ ] Одна міграція; `drizzle-kit generate` повторно → «No schema changes»; `test:pg`; `documentation/backend/database.md`.

---

## N · 🔵 feat-082 · Env-парсери — єдиний контракт (0.5 д)

**Зміна поведінки**, тому окремо від H: `config/auth.ts:1-7` приймає `'1'|'true'`, `vendor/utils/env/parse-boolean.ts` — ще `'yes'|'on'`; `parseNumberFlag` (`auth.ts:9-16`) через `Number()` приймає `1e3`, `0x10`, від'ємні.

- [ ] Контракт у `documentation/backend/configuration.md`: boolean = `true|1|yes|on` / `false|0|no|off` (case-insensitive), інше — config error; integer = десяткове, в межах `{min,max}`, інше — config error.
- [ ] `vendor/utils/env/read-int.ts`; усі boolean через `parse-boolean.ts`; `config/auth.ts` підключити до `validate-runtime-config.ts`.
- [ ] Замінити `readInt/readInteger/readTimeoutMs/readPromptCacheTtlMs/parsePort/parseNumberFlag`.
- [ ] Критерій: таблиця значень × змінних у spec; `AUTH_PHONE_ENABLED=yes` тепер `true`; `AUTH_*=1e3` → startup error з назвою змінної.

---

## O · 🔵 feat-083 · Locale-стаби — рішення продукту (0.25 д після рішення)

**Зміна поведінки UI**, тому окремо: 17 файлів `locales/*.ts` — `export default en`; `APP_LOCALE_CODES` рекламує 18 мов.

- [ ] Рішення: (a) показувати лише `en` до появи перекладів, або (b) залишити 18 у списку як «заплановані» з fallback на `en`. Узгодити з власником продукту.
- [ ] Реалізація: видалити стаби; `plugins/i18n.ts:46-54` `loadLocale` з fallback на `en` при невдалому `import()`; при (a) — `SHIPPED_LOCALES` у shared і фільтр у перемикачі.
- [ ] Критерій: вибір будь-якої локалі не ламає UI; e2e на перемикання.

---

## Зведена таблиця

| #     | Feature      | Що                                                                                                  | Пріоритет | Залежності     | Оцінка  |
| ----- | ------------ | --------------------------------------------------------------------------------------------------- | --------- | -------------- | ------- |
| A     | feat-058     | IDOR push-підписок                                                                                  | 🔴        | —              | 0.5 д   |
| B     | feat-059     | Відкликання сесій: звірка `userToken` з БД (без кешу), ротація в `changePassword`/`logoutAll`/reset | 🔴        | A              | 1.5–2 д |
| B2    | feat-060     | Гонка одноразових токенів — транзакційний claim-then-act                                            | 🔴        | **B**          | 0.5–1 д |
| B3    | feat-061     | Кеш `userToken` з визначеною `SESSION_REVOCATION_MAX_DELAY` (опційно, за бенчмарком з B)            | 🟠        | B              | 1 д     |
| C     | feat-062     | Відкликання WS admin: pub/sub + періодична перевірка підписок                                       | 🔴        | —              | 1.5 д   |
| D     | feat-063     | Support chat: admit-контракт у WS, lock з власником, атомарний бюджет, multipart                    | 🟠        | A              | 2.5 д   |
| E     | feat-064     | OAuth-токени (міграція)                                                                             | 🟠        | —              | 1 д     |
| F1    | feat-065     | Prompt retention policy (міграція, purge)                                                           | 🟠        | рішення        | 1 д     |
| F2    | feat-066     | Auth-контракт: unverified login, timing реєстрації                                                  | 🟠        | —              | 0.5 д   |
| F3    | feat-067     | `PGSQL_SSL`, SQL-логер                                                                              | 🟠        | —              | 0.25 д  |
| F4    | feat-068     | Frontend/SW/playground дрібне                                                                       | 🟠        | —              | 0.25 д  |
| G     | feat-069     | Регресійне покриття: snapshot auth, e2e на mocks, e2e з реальним backend                            | 🟡        | B, B2, F2      | 2 д     |
| H1–H5 | feat-070…074 | Auth refactor по кроку                                                                              | 🟢        | B2, G, K1      | 4 д     |
| I     | feat-075     | FE/shared dedup                                                                                     | 🟢        | G2, G3, K2, K3 | 2 д     |
| J     | feat-076     | FE split components                                                                                 | 🟢        | G2, G3, I      | 2 д     |
| K1–K3 | feat-077…079 | Dead code backend / shared / frontend                                                               | 🟢        | —              | 1 д     |
| L     | feat-080     | Repo hygiene, lint, CI pins                                                                         | 🔵        | —              | 0.5 д   |
| M     | feat-081     | Schema (cascade, index)                                                                             | 🔵        | F1 рішення     | 0.5 д   |
| N     | feat-082     | Env-парсери — контракт                                                                              | 🔵        | —              | 0.5 д   |
| O     | feat-083     | Locale-стаби — рішення продукту                                                                     | 🔵        | рішення        | 0.25 д  |

Рішення, які потрібні від власника продукту до старту відповідної фази: F1 (що зберігати з промптів і скільки), D3 (пагінація історії в UI), M (usage після видалення юзера), O (список мов), K3 (чи потрібні `browserName/osName/deviceType` на сервері).
