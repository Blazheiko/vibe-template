# ADR 0002: відкликання сесій через звірку `userToken` з БД

- **Статус:** чернетка (пропозиція; приймається разом із PR фази B, feat-059).
- **Дата запису:** 2026-10-31.
- **Джерело:** [`docs/security/code-review-main-2026-10-31.md`](../security/code-review-main-2026-10-31.md), знахідка №2; план — [`docs/plan/code-review-fixes-tasks.md`](../plan/code-review-fixes-tasks.md), фаза B.

## Контекст

Сесія автентифікованого користувача живе в Redis під ключем `session:<userToken>:<sessionId>`; `userToken` — значення `users.sessionToken`, скопійоване в дані сесії при вході. Запит вважається автентифікованим, якщо ключ сесії існує й підпис cookie правильний (`vendor/utils/session/session-handler.ts`, `vendor/utils/session/redis-session-storage.ts`, `app/websocket/ws-session-auth.ts`). Жоден із цих шляхів не порівнює `userToken` сесії з актуальним `users.sessionToken`.

Наслідки, підтверджені в коді на `a82b65a`:

1. `authService.changePassword` (`auth-service.ts:1268-1353`) оновлює лише `password`; `renewSession` викликає `auth.login(userId, userToken)` зі **старим** `userToken`. Усі інші сесії користувача залишаються валідними до 24 год (sliding) — вкрадена cookie переживає зміну пароля.
2. `password-reset-service.ts:616-639` ротує `users.sessionToken` і викликає `destroyAllSessions(previous)`, але ротація в БД нічого не відкликає: якщо SCAN/DEL не завершився (Redis недоступний, вичерпано deadline — `RedisUnavailableError` у `destroyAllSessions`), старі ключі залишаються валідними після відновлення Redis.
3. `context.auth.logoutAll` (`session-handler.ts:404-425`) лише викликає `destroyAllSessions` і видає анонімну cookie; `users.sessionToken` не змінюється, тож має ту саму прогалину.

Тобто «відкликання» сьогодні — це best-effort видалення ключів, а не перевірка під час запиту.

## Рішення

1. **Звірка з БД на кожен автентифікований запит.** `auth_guard` (HTTP) і `ws-session-auth` (кожне WS-повідомлення) порівнюють `session.data.userToken` із `users.sessionToken`, прочитаним безпосередньо з БД (`SELECT session_token FROM users WHERE id = $1`, індекс по PK). Один helper `assertSessionTokenCurrent(sessionInfo): Promise<'ok' | 'mismatch' | 'unavailable'>` у `vendor/utils/session/`; анонімні сесії пропускаються без запиту до БД.
2. **Fail-closed.** `mismatch` → знищити сесію, відповісти 401. `unavailable` (помилка або timeout БД) → 503; запит **не** пропускається лише за Redis-записом. Для WS — закрити з'єднання кодом, що означає тимчасову недоступність, щоб клієнт перепідключився, а не обробляти повідомлення.
3. **Використовуємо наявний `userToken`.** Окреме поле (`sessionGeneration`) не додає гарантій: воно має ту саму вимогу актуальності перевірки.
4. **Усі шляхи відкликання ротують `users.sessionToken` у БД до очищення Redis:** `changePassword`, `password-reset`, `logoutAll`. `destroyAllSessions` залишається best-effort очищенням пам'яті Redis, помилка якого логується й не змінює результат відкликання.
5. **`logoutAll`** — зовнішній контракт (`auth.logoutAll(): Promise<number>` і відповідь `authService.logoutAll`) не змінюється. Ротацію виконує `authService.logoutAll` **до** виклику `auth.logoutAll()` (`userRepository.update(userId, { sessionToken: nanoid() })`), а не vendor-шар: `session-handler` не має доступу до репозиторіїв, і інжекція `rotateUserToken` у нього ускладнила б ядро заради одного виклику.
6. **Зміна пароля — умовний UPDATE**, а не «перевірив → записав»: `UPDATE users SET password = $new, session_token = $newTok WHERE id = $id AND password = $currentHash RETURNING …`. Два одночасні запити з однаковим правильним старим паролем і різними новими дають рівно одну успішну зміну; другий отримує 409. Throttle (`changePasswordUser`) операції не серіалізує.
7. **Поточний клієнт після зміни пароля** отримує нову сесію (`auth.login(userId, newSessionToken)`) із новими CSRF-токеном і `wsToken`; стара cookie недійсна.

## Розглянуті альтернативи

- **Кеш `users.sessionToken` у Redis (TTL ~60 с, інвалідація при ротації).** Відхилено для першої реалізації: (а) якщо Redis недоступний під час інвалідації, після відновлення кеш може містити старий токен — критерій «після відновлення одразу 401» не гарантується; (б) гонка: паралельне читання з БД до інвалідації може записати старе значення в кеш уже після неї. Кеш можливий лише як окремий крок (feat-059c, B3) з явно визначеною допустимою затримкою відкликання `SESSION_REVOCATION_MAX_DELAY` і тестами обох сценаріїв.
- **Лише `destroyAllSessions` (статус-кво).** Відхилено: немає гарантії при збої Redis.
- **Поле `sessionGeneration`.** Відхилено: еквівалентно `userToken`, додає міграцію без нових гарантій.
- **Перевірка в Redis-сесії без БД (позначка «відкликано» в Redis).** Відхилено: та сама залежність від доступності Redis під час запису позначки.

## Наслідки

- +1 читання по первинному ключу на кожен автентифікований HTTP-запит і WS-повідомлення. Виміряти p50/p95 `auth_guard` до/після (локальний Postgres) у `progress.md` фічі — вхідні дані для рішення про B3.
- Недоступність БД тепер дає 503 на автентифікованих маршрутах (раніше сесія працювала лише від Redis). Це свідомий fail-closed.
- Відкликання не залежить від успіху очищення Redis: після збою `destroyAllSessions` старі сесії отримують 401 на першому ж запиті.
- Зміна пароля й `logoutAll` стають операціями «ротація в БД → best-effort очищення».
- `documentation/backend/auth.md` описує механізм, поведінку при збої Redis/БД і те, що `destroyAllSessions` — очищення, а не гарантія.

## Критерії приймання (повні — у плані, фаза B)

- Стара cookie, інша сесія, відкритий WS-сокет іншої сесії → 401/відхилення після зміни пароля, reset і `logoutAll`.
- Збій Redis під час `destroyAllSessions` → на першому ж запиті після відновлення стара сесія дає 401 без повторного очищення.
- БД недоступна під час перевірки → 503, сесія не знищена й не пропущена.
- Два конкурентні `changePassword` з однаковим старим паролем → рівно один 200.
