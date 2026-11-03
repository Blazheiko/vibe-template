# План: прибирання сесійного шару (feat-101)

Джерело: рев'ю сесій і автентифікації, пункти 4–7, і рев'ю цього плану. Кожен пункт перевірено в коді `main` на `9b273d2`.

## Ухвалені рішення

- **Контракт logout-all.** Після **успішної** ротації `session_token` ні недоступність Redis, ні дедлайн очищення, ні будь-яка інша помилка очищення не змінюють успішного результату: `200`, нова анонімна cookie і CSRF-токен, сповіщення `security(..., 'logout_all')`. Відкликання вже відбулося (ADR 0002), записи, що лишилися, відхиляються перевіркою токена й спливають за TTL. Якщо ротація **не вдалася** (сесію відкликано, користувача немає, помилка БД), поведінка лишається як зараз: помилка, очищення не запускається, сповіщення не надсилається.
- **Неочікувана помилка очищення в logout-all** (не `RedisUnavailableError`, тобто баг) після ротації теж дає `200`: так само поводиться зміна пароля. Вона логується через `logger.error({ err, userId }, ...)`, і транспорт логера (`vendor/utils/logger.ts:86`) сам передає її в Sentry. Окремий `captureException` не потрібен, бо він створить дубль. Недоступність Redis і дедлайн логуються як `warn`.
- **`session_api` видаляємо.** Middleware не використовує жоден маршрут і не покритий тестами. Bearer-сесій без CSRF-моделі для них у шаблоні не потрібно.
- **`unhandledRejection` не чіпаємо.** Node у режимі `throw` перетворює відхилений проміс на `uncaughtException` з `origin = 'unhandledRejection'`, і `handleUncaughtException` (`index.ts`) коректно зупиняє сервер. Це свідома зупинка, а не дефект.

## Підтверджені проблеми

### 4. Повтор logout-all через HTTP недосяжний (+ супутній дефект)

- `authService.logoutAll` ротує `session_token` **до** `auth.logoutAll()`. Після `503` наступний запит з тією ж cookie отримує `mismatch` у `RequestSession.restore`, і `dropRevokedSession` видаляє сесію. Код `keepSessionId`, курсору `logout_all:cursor:*` (TTL 600 с) і фінального `MULTI` виконується, але сценарій, заради якого він існує, тобто повтор від ще автентифікованого клієнта, через HTTP недосяжний. Ключ курсора після перерваного обходу висить до TTL.
- Документація суперечить сама собі: `documentation/backend/auth.md:174` («повторного очищення не потрібно») проти `:213–216` (курсор і повтор).
- Супутній дефект. Коли `destroyAllSessions` кидає помилку:
    - `becomeAnonymous()` не викликається, тож нова анонімна cookie не видається;
    - сповіщення `logout_all` не надсилається, хоча сесії вже відкликані;
    - клієнт бачить `503` на операцію, яка фактично вдалася.

### 5. Cookie збереженої анонімної сесії живе `sessionConfig.age`

Для stored cookie з `anon_session` значення `presentedUserToken === 'anon_session'`, тому `request-session.ts:245` бере `sessionConfig.age`, а запис у Redis живе `anonAge` (`ttlFor`). Це безпечно, але суперечить задуму.

### 6. Невикористаний `session_api`

Middleware зареєстрований у `app/middlewares/kernel.ts`, але жоден маршрут його не використовує. Без заголовка `Authorization` він передає `''` замість `undefined`, і на кожен запит пишеться `warn`. У `auth.md:218` він описаний як робоча можливість.

### 7. Дрібниці

- a) `Session.destroySession(sessionId)`: обидві реалізації (HTTP і WS) ігнорують аргумент, а `auth-service.ts:270` і `:375` його передають. `Session.destroyAllSessions(userId)` ніхто не викликає, і параметр насправді userToken.
- b) OAuth state порівнюється через `!==` (`oauth-service.ts:320`), хоча скрізь у проєкті використовується `timingSafeEqual`.

## Семантика `destroyAllSessions`

Нова сигнатура: `destroyAllSessions(userToken): Promise<{ deleted: number; complete: boolean }>`.

- `complete: true`: `SCAN` дійшов до курсора `0` без помилок.
- `complete: false`: обхід зупинено через `RedisUnavailableError` або дедлайн `REDIS_LOGOUT_ALL_DEADLINE_MS`. Функція не кидає помилку, а пише `warn`.
- `deleted` — кількість видалень, **підтверджених відповідями Redis**. `withTimer` використовує `Promise.race` і не скасовує вже відправлену команду, тож після таймауту фактично видалених записів може бути більше.
- Будь-яка інша помилка (баг) кидається далі, як і зараз (`withRedis` повторно кидає некласифіковані помилки, `redis-health.ts:145`).
- `complete` — внутрішній прапорець. Публічна відповідь `POST /api/auth/logout-all` не змінюється: `{ status, deletedCount, csrfToken }`, де `deletedCount = deleted`. Схеми в `shared` не чіпаємо.

## Порядок роботи

0. PR у `main`: додати `feat-101` у `feature_list.json` (owner, branch `fix/feat-101-session-cleanup`, статус `in_progress`). Створити `progress.md` на гілці.

### Коміт 1 — logout-all

1. `redis-session-storage.ts`: переписати `destroyAllSessions` за семантикою вище. Прибрати `keepSessionId`, `cursorKey`, `LOGOUT_ALL_CURSOR_TTL_SECONDS` і фінальний `MULTI`; обхід завжди від `0`. Оновити JSDoc.
2. Шляхи, що вже закомітили зміну (зміна пароля в `auth-service.ts`, `destroySessionsQuietly` в `account-claim-service.ts`, який використовують скидання пароля й OAuth): **зберегти зовнішній `try/catch`** для неочікуваних помилок і додати `warn` при `complete: false`. Операція, що вже закомітилася, ніколи не повертає помилку через очищення.
3. `request-session.ts`, `logoutAll()`:
    - викликати `destroyAllSessions(userToken)` без `this.info.id`;
    - `becomeAnonymous()` у `finally`, щоб анонімна cookie видавалася навіть при неочікуваній помилці;
    - повертати `{ deleted, complete }`; оновити тип `Auth.logoutAll` у `vendor/types/types.d.ts` і заглушку в `http-context.ts`;
    - оновити коментарі `:116` і `:366–369`.
    - **у цьому ж коміті** прибрати `Session.destroyAllSessions`: тип у `types.d.ts`, WS-реалізацію в `session-handler.ts:116` (вона повертає `Promise<number>` і після зміни результату сховища не скомпілюється), заглушку в `http-context.ts` і рядок таблиці `auth.md:60`. Так кожен коміт лишається робочим.
4. `auth-service.ts`, `logoutAll`:
    - ротація без змін і йде першою; при невдачі повертається помилка, `auth.logoutAll()` не викликається, сповіщення немає;
    - після успішної ротації виклик `auth.logoutAll()` у `try/catch`: неочікувана помилка → `logger.error({ err, userId }, ...)` (у Sentry через транспорт логера), `deletedCount: 0`; `complete: false` → `warn`;
    - сповіщення `security(userId, 'logout_all')` і `200` в обох випадках.
5. Тести:
    - `logout-all-retry.redis.test.ts` **переписати**, а не видаляти (перейменувати на `logout-all.redis.test.ts`). Зберегти сценарії з реальним Redis: повне очищення, частковий результат після кількох `DEL`, збій першого `SCAN`, дедлайн, ізоляція чужих ключів. Наявний HTTP-сценарій (`:173`) збиває Redis уже після middleware; змінити очікування з `503` на `200` + нова анонімна cookie + новий CSRF-токен + виклик `security(..., 'logout_all')` (перевіряється виклик, а не доставка push). Після відновлення Redis стара cookie не автентифікує. Сценарій `:226` (скидання пароля після перерваного logoutAll) переписати на «скидання пароля дочищає записи, що лишилися».
    - Прибрати тести курсора й `keepSessionId` у `redis-session-storage.spec.ts`; додати unit-тести: дедлайн → `{ complete: false, deleted: n }` без кидання; неочікувана помилка кидається.
    - Негативні тести `authService.logoutAll`: ротація не вдалася (відкликана сесія, немає користувача, помилка БД) → не `200`, `auth.logoutAll` не викликано, сповіщення немає.
    - Тест: неочікувана помилка очищення після ротації → `200`, анонімна cookie, `logger.error`.
    - Зміна пароля і `destroySessionsQuietly`: `complete: false` і неочікувана помилка не ламають успішну відповідь.
    - `session-before-send.spec.ts`: для неочікуваної помилки очищення перевіряти не лише rejection `auth.logoutAll()`, а й те, що після `finally` видана анонімна cookie.
    - **Міграція всіх моків `destroyAllSessions`** на `{ deleted, complete }`. Зовнішній `catch` у шляхах, що вже закомітилися, може приховати мок неправильної форми, тож одного зеленого тесту недостатньо. Кожен мок привести до нової форми явно; там, де перевіряється очищення, перевіряти й аргументи виклику. Файли (`grep -rl destroyAllSessions packages/backend/src`):
        - `app/services/auth/`: `password-reset-service.spec.ts` (`:340` повертає числа), `password-reset-service.contract.spec.ts` (`:205` повертає `undefined`), `password-reset-service.throttle-contract.spec.ts`, `account-claim-service.spec.ts`, `auth-service.spec.ts`, `auth-service.contract.spec.ts`, `auth-service.regression.spec.ts`, `auth-service.throttle-contract.spec.ts`, `auth-phone-foundation.spec.ts`, `auth-email-templates.snapshot.spec.ts`, `session-revocation.pg.test.ts`, `session-revocation-http.pg.test.ts`, `one-time-token-race.pg.test.ts`, `register-race.pg.test.ts`, `oauth-pre-hijack.pg.test.ts`;
        - `app/middlewares/csrf-guard.spec.ts`;
        - `vendor/utils/session/`: `redis-session-storage.spec.ts`, `redis-session-storage-logging.spec.ts`, `session-before-send.spec.ts`, `session-revocation.spec.ts`, `ws-session-handler.spec.ts`.
6. Документація: `documentation/backend/auth.md:48`, `:174`, `:213–216`. Прибрати курсор і повтор, описати контракт «після ротації — завжди 200», семантику `deletedCount` (підтверджені видалення, при неповному очищенні може бути менше фактичного). Перевірити опис `REDIS_LOGOUT_ALL_DEADLINE_MS` у `configuration.md`.

### Коміт 2 — TTL анонімної cookie

1. Експортувати `ttlFor` з `redis-session-storage.ts` і використати його в `request-session.ts:245` замість `userToken === undefined ? anonAge : age`.
2. Unit-тест `RequestSession.restore` з примусово дозволеним refresh: `claimCookieRefresh` (`request-session.ts:233`) повертає `true`, бо інакше stored cookie видається не на кожному запиті. Два випадки: `anon_session` → `maxAge === anonAge`; токен користувача → `maxAge === age`.

### Коміт 3 — видалення `session_api`

1. Видалити `vendor/utils/middlewares/http/session-api.ts` і рядок `session_api` у `app/middlewares/kernel.ts`.
2. Перевірити тип імен middleware: якщо `session_api` є в union/переліку, прибрати.
3. Оновити коментарі в `app/routes/upload-limits.spec.ts`, `push-subscription-ownership.pg.test.ts` і `app/services/core/main-service.ts:46`.
4. `auth.md`: прибрати всі згадки `session_api` — рядки 37, 45, 170 і 218 (на 218 також опис `Authorization: Bearer`). Наприкінці перевірити: `grep -rn session_api documentation packages/backend/src` нічого не знаходить.

### Коміт 4 — дрібниці

1. `types.d.ts`: `destroySession: () => Promise<void>` (`Session.destroyAllSessions` уже прибрано в коміті 1). Оновити `http-context.ts`, `session-handler.ts` (WS) і два виклики в `auth-service.ts`.
2. Спільний хелпер `safeEqual(a: string, b: string): boolean`: **лише байтове порівняння** (перевірка довжини + `timingSafeEqual`), без перевірки формату.
    - `csrf-guard.ts`: `safeTokenEqual` лишає `isValidCsrfToken` для обох значень і далі викликає `safeEqual`.
    - `oauth-service.ts` (`handleCallback`): `!safeEqual(storedState, receivedState)`, без CSRF-формату.
    - Тест на хелпер: рівні, різні тієї ж довжини, різної довжини, порожні рядки.
3. `index.ts`: коментар біля `uncaughtException`, що необроблені відхилення проходять через нього (`origin = 'unhandledRejection'`).

## Definition of Done

- `pnpm typecheck`, `pnpm lint`, `pnpm test` чисті. Кожен коміт окремо проходить `pnpm typecheck`.
- Інтеграційні набори окремо, бо `pnpm test` їх виключає:

    ```sh
    pnpm --filter backend test:redis
    pnpm --filter backend test:pg
    ```

    У виводі **жодного пропущеного** (`skipped`) файлу чи тесту: без налаштованого Redis/PostgreSQL набори пропускаються мовчки. Підсумкові рядки обох команд записати в evidence.

- `pnpm docs:build && pnpm docs:verify`.
- Ручна перевірка:
    - вхід з двох браузерів → logout-all в одному → другий анонімний, перший отримав анонімну cookie;
    - **Redis недоступний ще до запиту** → `503` на етапі відновлення сесії (`RequestSession.restore` читає Redis до сервісу), `users.session_token` у БД не змінено;
    - **сесію перевірено, токен ротовано, очищення перервано** (збій Redis після middleware; відтворюється через `logout-all.redis.test.ts` або малий `REDIS_LOGOUT_ALL_DEADLINE_MS` на великій кількості сесій) → `200`, нова анонімна cookie; після відновлення Redis стара cookie не автентифікує;
    - анонімна сесія з даними (наприклад, OAuth state) → `Max-Age` cookie дорівнює `SESSION_ANON_TTL`.
- Evidence у `progress.md`, `feat-101` → `done` через PR у `main`.
