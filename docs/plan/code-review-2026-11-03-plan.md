# План виправлень за code review бекенду (2026-11-03)

**Статус: чернетка, редакція 3.** Джерело: code review пакета `packages/backend` на `main` @ `e9c4f9d`
(2026-11-03); ключові пункти звірено з `main` @ `db24659`.
Знахідки, позначені ✅, перевірено в коді вручну; решту знайдено рев'ю з посиланням на код. Перед
початком кожної фічі знахідку відтворюємо тестом (RED), і лише тоді виправляємо.

**Редакція 2** (після рев'ю плану):

- R01 очищає весь серіалізований запис помилки (`stack`, `cause`, `detail`, `query`, `params`), а не лише `message`.
- Між R02 і R06 тепер явна залежність, а методи SMS-репозиторію приймають transaction executor.
- R03 закриває обидва канали, через які повертаються логи push, точно визначає allowlist і фіксує поведінку редиректів.
- R06 розділено: phone reset піднято до high.
- R07 звужено: довіра до unix-сокета лише за явною конфігурацією.
- R09 піднято до medium, а гарантії «не воскрешати» і «не губити паралельні оновлення» розділено.
- R10 отримав окремий обмежений probe замість пулу сесій.
- R11 і R12 розбито на менші фічі; R12b потребує зміни схеми.
- До DoD додано обов'язкові PG/Redis suites.

**Редакція 3** (друге рев'ю плану):

- R11b: версія контенту замість `updated_at`; R11d тепер після R11b.
- R09: поведінка `RequestSession` при втраті сесії окремо для `restore` і для запущеної операції.
- R06a/R06b: явна семантика commit/rollback для бізнес-помилок; executor у `changePasswordIfCurrent`.
- R11c: контракт власності Redis-лока.
- R12b: межа «виклик стартував» і рівно один запис аудиту.
- R07: `TRUSTED_PROXY_CIDRS`; R10: тест відновлення probe.

## Правила

- Кожна фіча — окремий запис у `feature_list.json` через PR у `main`. Id нижче (`R01…`) — робочі;
  реальний id (`feat-102`, …) присвоюється при створенні запису.
- Одна фіча в роботі на власника; `progress.md` і `session-handoff.md` — на гілці фічі.
- Шаблон без продакшену: без зворотної сумісності, міграції даних не потрібні.
- Зміна публічної поведінки бекенду (env, маршрут, middleware, схема) оновлює сторінку в
  `documentation/backend/` у тому ж PR; `pnpm docs:build && pnpm docs:verify`.

### Definition of Done (доповнення до `AGENTS.md`)

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, ручна перевірка, evidence у `progress.md`.
- `pnpm test` **не** запускає `*.pg.test.ts` і `*.redis.test.ts` (`packages/backend/vitest.config.ts:21`).
  Фіча з позначкою **PG** або **Redis** у таблиці також вимагає `pnpm --filter backend test:pg` /
  `test:redis` на піднятих тестових сервісах. Evidence містить вивід, у якому цільові тести
  виконані, а не пропущені (`skipped = 0` для нових файлів).
- Кожне виправлення має тест, що падає до зміни.
- Тести гонок використовують керовані бар'єри (deferred-проміс або hook у репозиторії між читанням і записом), а
  не `setTimeout` чи сподівання на випадковий порядок.

## Рішення, потрібні від власника

Критерії приймання нижче написані під рекомендований варіант. Якщо рішення інше, відповідна фіча
переписується до старту.

| #   | Питання                               | Рекомендація                                                                                | Альтернатива                                 |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Д1  | Як обмежити push endpoint (R03)       | Allowlist hostname відомих push-сервісів + лише `https:`                                    | Резолвити DNS і блокувати приватні діапазони |
| Д2  | Абсолютний термін життя сесії (R09)   | 30 днів від `createdAt`, env `SESSION_MAX_AGE_DAYS`                                         | Не обмежувати, задокументувати               |
| Д3  | Префікс IPv6 для ключів лімітів (R07) | /64 (лише ключ ліміту; у логах — повна адреса)                                              | /56                                          |
| Д4  | Енумерація в link-флоу (R12a)         | Прийняти й задокументувати (лише автентифіковані, під лімітами на користувача й ціль)       | Генерична відповідь «код надіслано»          |
| Д5  | IP за unix-сокетом (R07)              | Явний прапорець `TRUST_UNIX_SOCKET_PROXY=true`, діє лише коли сервер слухає `APP_UNIX_PATH` | Не підтримувати; лише TCP + CIDR             |
| Д6  | Паралельні оновлення сесії (R09)      | Версія запису + Lua CAS; конфлікт → перечитати й повторити (≤3), далі помилка               | Last-writer-wins, задокументувати            |

## Фічі і залежності

| Фіча | Назва                             | Знахідки   | Пріоритет | Залежності | Розмір | Інтеграційні suites |
| ---- | --------------------------------- | ---------- | --------- | ---------- | ------ | ------------------- |
| R01  | Error Log Scrubbing               | 1          | high      | —          | S      | —                   |
| R02  | SMS Attempt Atomicity             | 2          | high      | —          | S      | PG                  |
| R03  | Push Endpoint SSRF                | 3          | high      | Д1         | M      | PG                  |
| R06a | Phone Reset Transaction           | 12         | high      | R02        | S      | PG                  |
| R11a | Prompt Context Replace            | 26         | low       | —          | XS     | —                   |
| R04  | WS Registry Lifecycle             | 4, 17      | high      | —          | M      | —                   |
| R05  | Mail Escaping & OAuth Fetch       | 5, 8       | medium    | —          | S      | PG                  |
| R06b | Reauth Throttle & Pending Tokens  | 7, 11      | medium    | R06a       | M      | PG, Redis           |
| R07  | Client IP Keys                    | 6, 9       | medium    | Д3, Д5     | M      | Redis               |
| R09  | Session Store Hardening           | 13, 18, 19 | medium    | Д2, Д6     | M      | Redis               |
| R08  | Server Lifecycle                  | 10, 14–16  | medium    | R04        | M      | —                   |
| R10  | Infra Config Guards               | 20, 21     | low       | —          | S      | PG                  |
| R11b | KB Embedding Consistency          | 22         | low       | —          | M      | PG                  |
| R11c | KB Init Single Run                | 23         | low       | —          | S      | Redis               |
| R11d | Storage Object Replacement        | 24, 25     | low       | R11b       | M      | PG                  |
| R12a | Link-flow Enumeration Decision    | 27         | low       | Д4         | XS     | —                   |
| R12b | LLM Usage Audit for Aborted Calls | 28         | low       | —          | M      | PG                  |

Жорсткі залежності:

- **R02 → R06a.** Обидві змінюють підтвердження SMS challenge, а R06a виконує його в транзакції.
- **R06a → R06b.** Обидві змінюють транзакції ротації облікових даних в `auth-service.ts` / `password-reset-service.ts`.
- **R04 → R08.** Обидві змінюють `onClose` і `closeAllWs` у `ws-handlers.ts`.

- **R11b → R11d** (координаційна). Обидві змінюють `support-knowledge-repository.ts`; `setScreenshot` /
  `clearScreenshot` зараз оновлюють `updated_at`, тож R11d має спиратися на версію контенту з R11b, а не на
  `updated_at`.

Решта фіч незалежні.

### Порядок (хвилі)

1. **Хвиля 1:** R01, R02, R03 (після Д1), R11a.
2. **Хвиля 2:** R06a (після R02), R04, R05.
3. **Хвиля 3:** R06b, R07, R09.
4. **Хвиля 4:** R08, R10, R11b, R11c, R11d.
5. **Хвиля 5:** R12a, R12b.

## Знахідки

Шляхи відносно `packages/backend/src/`, якщо не вказано інше.

| #   | Знахідка                                                                                                          | Де                                                                                                                                | ✅  |
| --- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --- |
| 1   | `DrizzleQueryError` несе `params` (хеші, `session_token`, email) у `message`, `stack`, `params` → stdout і Sentry | `vendor/utils/logger.ts:119`, `services/observability/sentry-service.ts`, `services/shared/report-app-error.ts`                   | ✅  |
| 2   | Паралельні запити обходять ліміт спроб SMS-коду                                                                   | `services/auth/sms-challenge.ts:123-150`, `repositories/auth/sms-auth-challenge-repository.ts:135`                                | ✅  |
| 3   | Довільний URL як push endpoint → SSRF; сирі помилки транспорту повертаються клієнту (`/logs`, `getSubscription`)  | `shared/src/schemas/push-subscription/create-subscription.ts:4`, `services/notifications/push-subscription-service.ts:54`, sender | ✅  |
| 4   | WS-реєстр тримає закриті сокети (await до unregister; немає перевірки закриття після `findRole`)                  | `vendor/utils/network/ws-handlers.ts:380`, `app/websocket/ws-coordinator.ts:16`, `ws-connection-registry.ts`                      | ✅  |
| 5   | `identity.providerName` без екранування в `intro` OAuth-листа                                                     | `services/notifications/email-templates.ts:146`, `services/auth/oauth-service.ts:628`                                             | ✅  |
| 6   | IPv6: ключ ліміту — повна /128                                                                                    | `vendor/utils/rate-limit/rate-limit-store.ts:215`, `services/auth/auth-throttle-service.ts`                                       | ✅  |
| 7   | Перевірка поточного пароля в link-email/link-phone без per-user throttle                                          | `services/auth/auth-service.ts:137-162, 621, 812`                                                                                 |     |
| 8   | `fetchJson` не перевіряє `response.ok`; порожній `providerUserId` приймається                                     | `services/auth/oauth-service.ts:47, 242, 370`                                                                                     | ✅  |
| 9   | За unix-сокетом IP = `'unknown'`, XFF не читається                                                                | `vendor/utils/network/get-ip.ts:141`                                                                                              |     |
| 10  | Shutdown: помилка Redis у `closeAllWs` перериває цикл; listen socket закривається не першим                       | `ws-handlers.ts:171-186`, `vendor/start/server.ts:748-759`                                                                        |     |
| 11  | Pending-токени скидання пароля переживають зміну пароля й logout-all                                              | `auth-service.ts` (`changePassword`, `logoutAll`)                                                                                 |     |
| 12  | Скидання пароля по телефону без `lockById`/транзакції; challenge підтверджується поза транзакцією                 | `services/auth/password-reset-service.ts:464-487`, `sms-challenge.ts:140`                                                         | ✅  |
| 13  | GETEX → SETEX окремо → оновлення воскрешає видалену logout-ом сесію; паралельні оновлення губляться               | `vendor/utils/session/redis-session-storage.ts:115-151`                                                                           | ✅  |
| 14  | `listen_unix` не перевіряє `token === false`                                                                      | `vendor/start/server.ts:732`                                                                                                      |     |
| 15  | Static cache handler без `.catch`                                                                                 | `vendor/start/server.ts:610`                                                                                                      |     |
| 16  | 304 через `res.end()` замість `endWithoutBody()`                                                                  | `vendor/start/static-server.ts:258, 376`                                                                                          |     |
| 17  | Результат `ws.send` ігнорується (дроп при backpressure)                                                           | `ws-handlers.ts:98-115`, `vendor/start/server.ts:118`                                                                             |     |
| 18  | Сесія без абсолютного терміну життя                                                                               | `redis-session-storage.ts:101`, `vendor/utils/session/request-session.ts:237`                                                     |     |
| 19  | `REDIS_PREFIX` не валідується; помилка logout-all логує повний ключ                                               | `config/redis.ts:11`, `redis-session-storage.ts:12-22, 191`                                                                       |     |
| 20  | Основний pg-пул без `query_timeout`; `/ready` може вичерпати пул                                                  | `database/db.ts:9`, `services/core/readiness-service.ts`                                                                          |     |
| 21  | Некоректний `SENTRY_TRACES_SAMPLE_RATE` — лише warn                                                               | `config/sentry.ts:8-20`                                                                                                           |     |
| 22  | Embedding KB лишається старим / перезаписується старішим                                                          | `services/support/knowledge-base-service.ts`, `repositories/support/support-knowledge-repository.ts` (`setEmbedding`)             |     |
| 23  | Init KB може запуститися двічі                                                                                    | `services/support/knowledge-base-init-service.ts` (`start`)                                                                       |     |
| 24  | Старий скріншот видаляється до завантаження нового                                                                | `knowledge-base-service.ts` (`uploadScreenshot`)                                                                                  |     |
| 25  | Паралельна зміна аватара лишає осиротілі S3-об'єкти                                                               | `services/user/avatar-service.ts:87-135`                                                                                          |     |
| 26  | `.replace('{context}', text)` інтерпретує `$&` у тексті KB                                                        | `services/support/support-llm-service.ts`                                                                                         |     |
| 27  | «Already linked to another account» розкриває зареєстровані адреси                                                | `auth-service.ts:660, 837`, `oauth-service.ts:491`                                                                                |     |
| 28  | Перерваний / невдалий стрім не пише рядок у `llm_text_usage`; у схемі немає `status`                              | `services/ai/usage/*`, `database/schema.ts:333`                                                                                   | ✅  |

## Фічі

### R01 — Error Log Scrubbing (знахідка 1)

**Зміни**

- Новий модуль `vendor/utils/errors/scrub-error.ts`: `toSafeError(err)` будує **нове** безпечне
  представлення й не змінює оригінальну помилку (її далі використовує `db-errors.ts`).
    - Для `DrizzleQueryError` і `pg` `DatabaseError` лишає `name`, `code`, `constraint`, `table`, `column`,
      `routine`. `message` стає `Failed query (params redacted)`.
    - `stack` перебудовується з безпечного `message` + кадрів (рядки `at …`); перший рядок оригінального
      stack (з params) відкидається.
    - `detail`, `query`, `params`, `where`, `internalQuery` не потрапляють у результат.
    - `cause` обробляється рекурсивно (з обмеженням глибини й захистом від циклів), включно з `AggregateError.errors`.
    - Спільна логіка з `src/db/seed/describe-error.ts`: перенести туди або переюзати.
- `logger.ts`: серіалізатори `err` і `error` через `toSafeError` замість `pino.stdSerializers.err`.
- `sentry-service.ts` `beforeSend`:
    - переписує `exception.values[].value`;
    - чистить `stacktrace`-незалежні поля;
    - рекурсивно (масиви й об'єкти) маскує `extra`, `contexts`, `breadcrumbs[].data`;
    - `captureException` отримує безпечне представлення.

**Критерії приймання**

- Тест: лог `logger.error({ err })`, де `err` — `DrizzleQueryError` з params `['secret-hash', 'tok']` і
  `cause` = pg-помилка з `detail: 'Key (email)=(a@b.c)'`. У **всьому** JSON-рядку запису (включно зі `stack`
  і `cause`) немає `secret-hash`, `tok`, `a@b.c`; `code`/`constraint` присутні.
- Тест: той самий об'єкт помилки після логування не змінений (`message`, `params` на місці).
- Тест: Sentry event з такою помилкою й вкладеним `extra.a[0].b.password` → серіалізований event не містить
  жодного секрету.
- `documentation/backend/observability.md`: розділ про редагування помилок БД.

### R02 — SMS Attempt Atomicity (знахідка 2) · PG

**Зміни**

- Репозиторій `sms-auth-challenge-repository.ts`: методи `consumeAttempt`, `markConfirmed`, `markInvalidated`,
  `invalidatePendingPhoneChallenges` приймають необов'язковий transaction executor (як інші репозиторії
  з `transaction.ts`). Це передумова для R06a.
- `consumeAttempt(id, max, tx?)`: `UPDATE … SET attempt_count = attempt_count + 1 WHERE id = ?
AND confirmed_at IS NULL AND invalidated_at IS NULL AND expires_at > now() AND attempt_count < max
RETURNING *`.
- `verifySmsCode`:
    - спершу `consumeAttempt`; немає рядка → `noLongerValid`, без порівняння коду;
    - потім порівняння коду;
    - невірний код на вичерпаному бюджеті → `markInvalidated`.
    - Будь-яка перевірка, зокрема успішна, витрачає спробу.
- `markInvalidated`: додати `confirmed_at IS NULL` у WHERE, щоб запізніла невірна спроба не інвалідувала вже підтверджений challenge.
- `markConfirmed`: умова `confirmed_at IS NULL` лишається єдиною гарантією «одного переходу». Бюджет спроб
  гарантує `consumeAttempt`, а не `markConfirmed`.

**Критерії приймання** (PG, керовані бар'єри)

- 10 паралельних `verifySmsCode` з невірними кодами на свіжий challenge → рівно `smsMaxInvalidAttempts`
  порівнянь (spy на `verifyOtpVerificationCode`), challenge invalidated, решта отримують `noLongerValid`.
- Два паралельні підтвердження з **правильним** кодом → рівно один успішний перехід (`markConfirmed` повертає рядок
  один раз), другий отримує `noLongerValid`.
- Бар'єр: challenge підтверджено, потім завершується запізніла невірна спроба → challenge лишається
  підтвердженим, `invalidated_at IS NULL`.
- Покриті три флоу: phone password reset, phone register, phone link.
- `documentation/backend/auth.md`: семантика ліміту.

### R03 — Push Endpoint SSRF (знахідка 3; рішення Д1) · PG

**Зміни**

- `config/push.ts`: `PUSH_ALLOWED_ENDPOINT_HOSTS` — список hostname. Запис без крапки на початку означає точний збіг.
  Запис `.domain` означає суфікс **на межі DNS-мітки**: `x.notify.windows.com` збігається з `.notify.windows.com`,
  а `evilnotify.windows.com` і `notify.windows.com.evil.io` не збігаються.
  Дефолт: `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `.notify.windows.com`, `web.push.apple.com`.
- `validatePushEndpoint(url)` в одному модулі, викликається при створенні, оновленні й **перед кожною відправкою**:
    - `new URL()`, лише `https:`, без userinfo, порт відсутній або 443;
    - hostname приводиться до нижнього регістру, кінцева крапка відкидається, IP-літерали (v4/v6) відхиляються;
    - IDN/punycode порівнюється в ASCII-формі;
    - інакше `400`.
- Транспорт:
    - `web-push` робить звичайний `https.request` і не переходить за редиректами (`node_modules/web-push/src/web-push-lib.js:369`), а 3xx вважає помилкою. Цю поведінку фіксує тест.
    - Опції `proxy`/`agent` для `sendNotification` не передаються, і це перевіряється тестом.
- Ліміт підписок на користувача `PUSH_MAX_SUBSCRIPTIONS_PER_USER` (дефолт 20).
- `rateLimit` на `POST /push-subscriptions/test-push` (5/хв).
- Спільний безпечний transformer логів (`pushNotificationLogTransformer`) для **обох** каналів:
  `GET /push-subscriptions/:id/logs` і `getSubscription` → `notificationLogs` (`push-subscription-service.ts:54`).
  Він віддає `status`, `statusCode` і нормалізований `reason` (`delivered` / `gone` / `rejected` / `network_error`),
  без `errorMessage` і `responseData`.

**Критерії приймання**

- `http://…`, `https://10.0.0.5/…`, `https://[::1]/…`, `https://169.254.169.254/…`,
  `https://user@fcm.googleapis.com/…`, `https://fcm.googleapis.com:8443/…`, `https://evil.com/fcm.googleapis.com`,
  `https://evilnotify.windows.com/…`, `https://fcm.googleapis.com.evil.io/…` → 400.
- Валідні FCM / Mozilla / `wns2-par02p.notify.windows.com` / Apple → 201; `FCM.GOOGLEAPIS.COM.` нормалізується.
- Рядок у БД з невалідним endpoint не відправляється (sender перевіряє повторно).
- Локальний HTTPS-сервер відповідає 302 на внутрішню адресу → другого запиту немає, лог має `reason = rejected`.
- 21-ша підписка відхиляється; `test-push` понад ліміт → 429.
- Відповіді `/logs` і `getSubscription` не містять тексту мережевих помилок; обидва тести на одному fixture.
- `documentation/backend/web-push-notification.md`, `configuration.md`, `packages/backend/.env.example`.

### R06a — Phone Reset Transaction (знахідка 12; після R02) · PG · high

**Зміни**

- `completePhonePasswordReset`: `withTransaction` + `userRepository.lockById`.
- На заблокованому рядку повторно перевірити `email IS NULL AND phone = challenge.phone`.
- `consumeAttempt`/`verify`, `markConfirmed`, `invalidatePendingPhoneChallenges`, оновлення пароля й `session_token`,
  а також `passwordResetRepository.invalidatePendingByUserId` виконуються в одній транзакції через executor з R02.
- Знищення Redis-сесій — після commit (як у feat-096).

**Семантика commit / rollback.** `withTransaction` (`repositories/transaction.ts:12`) відкочується лише на throw;
повернення `Result.err` з колбека завершує транзакцію **commit**-ом. Тому:

- Невірний SMS-код: `consumeAttempt` виконується **поза** транзакцією скидання (або транзакція повертає
  `Result.err` і комітить), тож витрачена спроба зберігається.
- Будь-яка відмова **після** `markConfirmed` (повторна перевірка рядка, оновлення пароля, інвалідація
  токенів) кидає виняток усередині колбека → відкочуються і підтвердження challenge, і зміна пароля. Бізнес-відмову
  на цьому етапі не повертаємо як `Result.err` з колбека; її загортаємо у внутрішній виняток і перетворюємо
  на `Result.err` після rollback.

**Критерії приймання** (PG, бар'єр між читанням і записом)

- Невірний код → `attempt_count` збільшено й закомічено; пароль не змінено.

- Email підтверджено між стартом і завершенням phone reset → reset відхилено, пароль не змінено.
- Збій оновлення користувача (інжектований виняток) → транзакція відкочена, challenge **не** підтверджено, його
  можна використати повторно в межах бюджету.
- Бізнес-відмова після підтвердження (email з'явився на заблокованому рядку) → challenge **не** підтверджено,
  пароль не змінено (перевіряє саме шлях «відмова → rollback», а не лише exception).
- Збій `invalidatePendingByUserId` → відкочено підтвердження й зміну пароля.
- Два паралельні завершення з правильним кодом → один успіх.

### R06b — Reauth Throttle & Pending Tokens (знахідки 7, 11; після R06a) · PG, Redis

**Зміни**

- `requireCurrentPasswordReauth` списує per-user throttle (нова політика `reauthUser`, 10 / 15 хв у
  `config/throttle-policies.ts`) **до** `validatePassword`. Успіх скидає лічильник.
- `changePassword` і `logoutAll` викликають `passwordResetRepository.invalidatePendingByUserId` у тій самій транзакції,
  що й ротація `session_token`. Pending email-verification токени — лише для зміни пароля, якщо це не ламає link-флоу
  (вирішити в PR, зафіксувати в `auth.md`).
- `userRepository.changePasswordIfCurrent` (`repositories/user/user-repository.ts:290`, зараз глобальний `db`) і
  метод ротації для `logoutAll` отримують `executor: DbExecutor = db`. `passwordResetRepository.invalidatePendingByUserId`
  — так само.
- Семантика: умовна ротація не спрацювала (конфлікт / відкликана сесія) → нічого не інвалідовано; збій інвалідації
  токенів → виняток у колбеку → ротацію облікових даних відкочено, клієнт отримує 500 і старий пароль чинний.

**Критерії приймання**

- 11-та невірна спроба пароля на `/auth/link-email/start` → 429 і для запиту з іншого IP (Redis).
- Reset-посилання, видане до `changePassword`/`logoutAll`, після них → «link no longer valid» (PG).
- Збій ротації → токени скидання не інвалідовано (одна транзакція).
- Збій інвалідації токенів (інжектований) → пароль і `session_token` не змінені (PG).
- `documentation/backend/auth.md`.

### R04 — WS Registry Lifecycle (знахідки 4, 17)

**Зміни**

- `onClose` синхронно, до будь-якого `await`:
    - ставить `userData.closed = true`;
    - видаляє сокет з `wsStorage`;
    - викликає синхронну частину відключення (unregister з реєстру, `adminWsChannelService`).
    - Redis-відкликання токена й асинхронний трекінг — після.
- `handleConnected`: після `await findRole`, якщо `userData.closed`, не реєструвати й вийти.
- Реєстр зберігає `appType` у записі; `summarizeAppType` не викликає `ws.getUserData()` на збережених сокетах.
- `sendJson`: перевіряти результат `ws.send`. `2` (dropped) → `logger.warn` і закриття сокета кодом 1013,
  або `closeOnBackpressureLimit` (вирішити в PR, зафіксувати в `websocket.md`).

**Критерії приймання** (бар'єри на `onRevokeToken` і `findRole`)

- `onClose` висить на `onRevokeToken`, тим часом реєструється новий сокет того ж користувача → новий сокет у
  реєстрі, без throw.
- Close до завершення `findRole` → сокет не в реєстрі, користувач не онлайн.
- `send` повертає 2 → warn + закриття.
- `documentation/backend/websocket.md`.

### R05 — Mail Escaping & OAuth Fetch (знахідки 5, 8) · PG

**Зміни**

- `renderBrandedEmail` екранує всі текстові поля (`preheader`, `eyebrow`, `title`, `intro`, label, `footer`). Для
  HTML за потреби є явне поле `introHtml`. JSDoc-контракт оновлено.
- `fetchJson`: `!response.ok` → throw зі `status`; callback завершується звичайною OAuth-помилкою.
- Порожній або нестроковий `userInfo.id` відхиляється для всіх провайдерів.

**Критерії приймання**

- `providerName = '"><a href="https://evil">x</a>'` → у HTML лише екрановані сутності.
- Провайдер відповідає 401/500 → користувача й OAuth-зв'язку не створено (PG).
- `id: ''` → відмова; запису `(gitlab, '')` немає (PG).

### R07 — Client IP Keys (знахідки 6, 9; рішення Д3, Д5) · Redis

**Зміни**

- Одна функція `rateLimitKeyForIp(ip)` у `get-ip.ts` для всіх лімітерів (L1, per-route, WS upgrade, auth-throttle):
    - IPv6 канонікалізується (стиснення, нижній регістр, IPv4-mapped → IPv4) і зводиться до /64;
    - IPv4 без змін.
- Фактичний IP (`getIp`) не змінюється й далі йде в логи, `user_online`, сесію.
- Unix-сокет: XFF читається лише якщо сервер **справді** слухає `APP_UNIX_PATH` (стан listener, а не порожня
  remote-адреса) **і** `TRUST_UNIX_SOCKET_PROXY=true`.
    - Порожня remote-адреса сама по собі не означає довіреного піра.
    - Розбір XFF — той самий, справа наліво з пропуском `TRUSTED_PROXY_CIDRS` (`config/network.ts:20`).
- `validateRuntimeConfig`: `APP_UNIX_PATH` без `TRUST_UNIX_SOCKET_PROXY` → попередження про спільний бюджет лімітів.

**Критерії приймання**

- `2001:db8:1:2::a` і `2001:DB8:1:2:0:0:0:b` → один ключ; `2001:db8:1:3::a` → інший; `::ffff:203.0.113.7` →
  ключ `203.0.113.7`.
- Unix listener + прапорець + XFF `198.51.100.9, 203.0.113.7` → IP `203.0.113.7`.
- Підроблений лівий запис (`1.2.3.4, 203.0.113.7`) не впливає на результат.
- Без прапорця, або TCP-listener з порожньою адресою → `unknown`, XFF ігнорується.
- Лог запиту з IPv6 містить повну адресу, не префікс.
- Redis-тест: дві адреси з однієї /64 ділять бюджет `loginIp`.
- Ручна перевірка: nginx → unix-сокет, лог показує реальний IP.
- `documentation/backend/security.md`, `configuration.md`, `deployment.md`.

### R09 — Session Store Hardening (знахідки 13, 18, 19; рішення Д2, Д6) · Redis · medium

Дві окремі гарантії, кожна зі своїм тестом.

**Зміни**

1. **Не воскрешати видалену сесію.**
    - Запис оновлення не створює ключ, якого немає.
    - `SET … XX` дає лише цю гарантію ([контракт `SET`](https://redis.io/docs/latest/commands/set/)), тому
      реалізація — Lua-скрипт, спільний із п. 2.
    - Ключа немає → сховище повертає «сесія зникла» (`null`). Що робить `RequestSession` — визначено окремо
      для двох моментів:
        - **Під час `restore`.** Зараз `restore` (`vendor/utils/session/request-session.ts:203`) при
          `updateSessionData() === null` лишає раніше завантажений `info`, і перевірка автентифікації читає саме його.
          Зміна: `null` → відкинути завантажений `info`, створити нову анонімну сесію (нова cookie, новий
          CSRF); `auth_guard` бачить анонімну сесію і відповідає 401.
        - **Під час уже запущеної захищеної операції.** Тихого переходу на анонімну сесію недостатньо.
          Запис сесії, який повернув `null`, кидає `SessionGoneError`; захищена дія припиняється до свого
          незворотного кроку, відповідь 401. Операції, що пишуть у сесію (OAuth start/callback, link-флоу), роблять цей
          запис **до** зовнішніх побічних ефектів (лист, SMS, запис у БД) або повторно перевіряють сесію перед ними.
2. **Не губити паралельні оновлення (Д6).**
    - Запис має поле `version`.
    - Lua: `GET` → порівняти `version` → `SET … KEEPTTL` (або з новим TTL) і `version + 1`.
    - Конфлікт → перечитати, застосувати зміну повторно (≤3 спроби), далі помилка з логом.
    - При last-writer-wins (альтернатива Д6) — задокументувати й додати тест, що фіксує цю поведінку.
3. **Абсолютний термін життя (Д2).**
    - `restore` відхиляє сесію, якщо `now - createdAt >= SESSION_MAX_AGE_DAYS`.
    - Відсутній, некоректний або майбутній (за межею допуску годинника 5 хв) `createdAt` теж → відхилити.
4. **`REDIS_PREFIX`.**
    - Валідація `^[A-Za-z0-9:_-]{1,16}$` у `config/redis.ts` + `validateRuntimeConfig`.
    - У лозі помилки logout-all ключ маскується.

**Критерії приймання** (Redis, бар'єри)

- DEL між читанням і записом оновлення → ключа після запису немає.
- HTTP: сесію видалено (logout в іншій вкладці) між `restore` і записом CSRF → запит до захищеного маршруту = 401,
  у відповіді нова анонімна cookie.
- HTTP: сесію видалено між читанням і записом у захищеній операції (бар'єр, наприклад `/auth/link-email/start`) →
  401, лист не надіслано, рядка верифікації немає, сесію не відновлено.
- Два паралельні оновлення різних полів → обидві зміни в результаті (Д6) або задокументована поведінка.
- `createdAt` рівно на межі → відхилено; на 1 с менше → прийнято; `createdAt = 'abc'` → відхилено;
  `createdAt` у майбутньому за межами допуску → відхилено.
- `REDIS_PREFIX=app.prod:` → помилка конфігурації при старті.
- `documentation/backend/configuration.md`, `security.md`.

### R08 — Server Lifecycle (знахідки 10, 14, 15, 16; після R04)

**Зміни**

- `stopServer`: спершу закрити listen socket, потім `closeAllWs`. Відкликання токенів або в try/catch на кожен
  сокет, або прибрати з `closeAllWs` (його вже робить `onClose`).
- `listen_unix`/`listen`: `token === false` → `logger.fatal` і `process.exit(1)`.
- Static cache route: `.catch`, як у fallback-маршруті (лог + 500, якщо не aborted).
- `static-server.ts`: 304 → `endWithoutBody()`.

**Критерії приймання**

- `onRevokeToken` кидає на першому сокеті → решта отримують 4201, listen socket закрито.
- Невалідний `APP_UNIX_PATH` → процес завершується з ненульовим кодом.
- raw-http: 304 без `Content-Length: 0`.

### R10 — Infra Config Guards (знахідки 20, 21) · PG

**Зміни**

- Основний pg-пул: `query_timeout` і `statement_timeout` з env (`DB_QUERY_TIMEOUT_MS`, дефолт 10000).
- Readiness: окремий обмежений probe, **не** пул перевірки сесій, щоб health-check не конкурував з автентифікацією.
    - Окремий `pg.Client` / пул `max: 1` з `connectionTimeoutMillis`, `query_timeout` і `statement_timeout` ≤ дедлайну `/ready`.
    - Наступний probe не стартує, поки попередній не завершився (повертається кешований результат «in progress → not ready»).
- `config/sentry.ts`: некоректний `SENTRY_TRACES_SAMPLE_RATE` → `configError`.

**Критерії приймання**

- PG: основний пул насичений (усі з'єднання зайняті `pg_sleep`) → `/ready` відповідає в межах дедлайну.
  Відповідь визначена (`503` або `200` — зафіксувати), а не висить.
- PG: БД, що приймає з'єднання, але не відповідає (`pg_sleep` у probe) → `/ready` = 503 до дедлайну; паралельні
  probe не накопичують з'єднань.
- PG: probe завершився за таймаутом → наступний `/ready` після того, як БД знову відповідає, повертає 200
  (probe не лишається «in progress» назавжди, з'єднання probe звільнено або перестворено).
- Конфіг: невалідний sample rate → помилка старту.
- `documentation/backend/configuration.md`, `observability.md`.

### R11a — Prompt Context Replace (знахідка 26) · XS

- `support-llm-service.ts`: `.replace('{context}', () => knowledgeContext)`.
- Тест: текст KB з `$&`, `` $` ``, `$'`, `$$` потрапляє в промпт дослівно.

### R11b — KB Embedding Consistency (знахідка 22) · PG

`updated_at` не годиться як версія: його задає `new Date()` (два оновлення можуть отримати однакове значення), а
`setScreenshot` / `clearScreenshot` змінюють його без зміни тексту (`support-knowledge-repository.ts:108-128`).

- Нова колонка `content_version integer NOT NULL DEFAULT 1` (міграція). `update` при зміні `title`/`content` у тому ж
  UPDATE робить `content_version = content_version + 1` і `embedding = NULL`. Скріншот версію не змінює.
- Індексація фіксує `content_version` (і текст) того рядка, який індексує; `setEmbedding(id, vector, version)` пише лише
  при `content_version = version`. Те саме для `create` (версія 1) і `reindexAll` (версія кожного рядка на момент
  читання).
- Тести (PG, бар'єр на виклику embedding):
    - два швидкі `update` з **однаковим** `updated_at` (фіксований годинник) → старіша індексація, що завершилась
      останньою, вектор не записує;
    - зміна скріншота під час індексації → вектор записується (версія не змінилась);
    - `reindexAll` паралельно з `update` → застарілий вектор не записано;
    - збій індексації → стаття не вважається проіндексованою.

### R11c — KB Init Single Run (знахідка 23) · Redis

- `start()` ставить `running` синхронно до першого `await` і скидає його на ранньому виході.
- Для кількох інстансів — Redis-лок за зразком `services/support/support-inflight-lock.ts`:
    - захоплення `SET key <token> NX PX ttl`, де `token` — випадковий ідентифікатор власника;
    - поновлення й звільнення — Lua, умовні на `GET key == token`;
    - поновлення не вдалося (lease втрачено) → `AbortSignal` імпорту спрацьовує, імпорт зупиняється перед наступним
      записом, статус `failed: lock lost`; звільнення після втрати — no-op.
- Тести (Redis):
    - подвійний `start()` в одному процесі → один імпорт;
    - два «інстанси» → лок отримує один;
    - A втратив lease (TTL минув) → B захопив лок → запізнілий A не може ні поновити, ні видалити лок B, а імпорт
      A зупинено.

### R11d — Storage Object Replacement (знахідки 24, 25) · PG

- Після R11b: зміна скріншота не змінює `content_version`, тож не інвалідує індексацію.
- Скріншот KB і аватар, однаковий порядок:
    1. завантажити новий об'єкт;
    2. умовний UPDATE, що повертає **попередній** ключ (`RETURNING` через CTE / `FOR UPDATE`);
    3. видалити попередній ключ.
- Збій кроку 2 → видалити щойно завантажений новий об'єкт.
- Тести (фейковий S3):
    - два паралельні успішні завантаження → у сховищі лишається рівно один об'єкт, і на нього посилається рядок;
    - збій S3 при завантаженні → старий об'єкт і рядок незмінні;
    - збій БД після завантаження → новий об'єкт видалено, старий на місці;
    - upload паралельно з delete → немає осиротілих об'єктів.

### R12a — Link-flow Enumeration Decision (знахідка 27; Д4) · XS

- За Д4: розділ у `documentation/backend/auth.md`, що link-флоу розкривають зайнятість адреси автентифікованому
  користувачу під лімітами на користувача й ціль. Альтернатива Д4 — генерична відповідь + тест.

### R12b — LLM Usage Audit for Aborted Calls (знахідка 28) · PG · M

- Зміна схеми `llm_text_usage`:
    - enum `status` (`completed` / `aborted` / `failed`), default `completed`;
    - `tokens_estimated boolean NOT NULL DEFAULT false`.
    - Міграція 1.0-формату через `drizzle-kit generate`.
- **Межа «виклик стартував»** — виклик `admission.budget.begin(call)` (напр. `support-service.ts:436`), який
  стається до запуску генератора. За поточним контрактом ADR 0003 після `begin` оцінку вже списано, тож помилка до
  першого чанка — теж витрата й пише рядок `failed`. Виклик без `begin` рядка не пише.
- **Статус і походження токенів незалежні.** `status` описує, як закінчився виклик; `tokens_estimated` — звідки токени:
  провайдер повідомив usage (навіть перед перериванням) → фактичні, `false`; не повідомив → оцінка, `true`.
  `aborted` не означає `estimated`.
- **Рівно один рядок на виклик.** Recorder виклику має прапорець «settled»; completion, error і abort handlers ідуть
  через одну `settle(status, usage?)`, повторні виклики — no-op.
- Статистика (`llm-usage-service`) відрізняє фактичні токени від оціночних.
- ADR 0003: доповнення про межу старту й аудит.
- Тести (PG):
    - `begin` → помилка провайдера до першого чанка → один рядок `failed`, `tokens_estimated = true`;
    - відомий usage, потім abort → один рядок `aborted`, `tokens_estimated = false`, фактичні токени;
    - abort без usage → `aborted`, `tokens_estimated = true`;
    - completion і пізня помилка / abort на тому самому виклику → рівно один рядок;
    - виклик, що не дійшов до `begin` → рядка немає;
    - успіх → `completed`, `tokens_estimated = false`.
- `documentation/backend/ai.md`, `database.md`.

## Стан

| Фіча | id       | PR  | Стан        |
| ---- | -------- | --- | ----------- |
| R01  | feat-102 |     | in_progress |
| R02  |          |     | not-started |
| R03  |          |     | not-started |
| R06a |          |     | not-started |
| R11a |          |     | not-started |
| R04  |          |     | not-started |
| R05  |          |     | not-started |
| R06b |          |     | not-started |
| R07  |          |     | not-started |
| R09  |          |     | not-started |
| R08  |          |     | not-started |
| R10  |          |     | not-started |
| R11b |          |     | not-started |
| R11c |          |     | not-started |
| R11d |          |     | not-started |
| R12a |          |     | not-started |
| R12b |          |     | not-started |
